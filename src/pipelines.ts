/**
 * Pipeline Manager for NanoClaw
 *
 * Multi-session experimental workflows stored as JSON files in the group folder.
 * Each pipeline is a sequence of steps that execute as regular scheduled tasks.
 * When a step completes, the next step is automatically scheduled with previous
 * step results injected as context.
 *
 * Pipeline state lives at groups/{folder}/pipelines/{id}.json — file-based,
 * inspectable, and version-controllable.
 */

import fs from 'fs';
import path from 'path';

import { createTask } from './db.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';
import { Pipeline } from './types.js';

function getPipelinesDir(groupFolder: string): string {
  const groupDir = resolveGroupFolderPath(groupFolder);
  return path.join(groupDir, 'pipelines');
}

export function readPipeline(
  groupFolder: string,
  pipelineId: string,
): Pipeline | null {
  const filePath = path.join(
    getPipelinesDir(groupFolder),
    `${pipelineId}.json`,
  );
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

export function writePipeline(pipeline: Pipeline): void {
  const dir = getPipelinesDir(pipeline.group_folder);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${pipeline.id}.json`);
  pipeline.updated_at = new Date().toISOString();
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(pipeline, null, 2));
  fs.renameSync(tmpPath, filePath);
}

export function listPipelines(groupFolder: string): Pipeline[] {
  const dir = getPipelinesDir(groupFolder);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
      } catch {
        return null;
      }
    })
    .filter(Boolean) as Pipeline[];
}

function buildStepPrompt(pipeline: Pipeline, stepIndex: number): string {
  const step = pipeline.steps[stepIndex];
  const total = pipeline.steps.length;

  const lines = [
    `[PIPELINE STEP ${stepIndex + 1}/${total}: ${step.name}]`,
    `Pipeline: ${pipeline.name} (${pipeline.id})`,
    '',
  ];

  // Include previous step results as context
  const completedBefore = pipeline.steps
    .slice(0, stepIndex)
    .filter((s) => s.status === 'completed');
  if (completedBefore.length > 0) {
    lines.push('Previous steps:');
    for (let i = 0; i < stepIndex; i++) {
      const prev = pipeline.steps[i];
      if (prev.status === 'completed' && prev.result) {
        lines.push(`- Step ${i + 1} (${prev.name}): ${prev.result}`);
      }
    }
    lines.push('');
  }

  lines.push('Your task for this step:');
  lines.push(step.prompt);
  lines.push('');
  lines.push(
    'When done, summarize what you accomplished. Your summary will be passed as context to the next pipeline step. Save detailed results to files in the workspace.',
  );

  return lines.join('\n');
}

function scheduleStep(pipeline: Pipeline, stepIndex: number): string {
  const step = pipeline.steps[stepIndex];
  const taskId = `pipeline-${pipeline.id}-step-${stepIndex}-${Date.now()}`;
  const prompt = buildStepPrompt(pipeline, stepIndex);

  createTask({
    id: taskId,
    group_folder: pipeline.group_folder,
    chat_jid: pipeline.chat_jid,
    prompt,
    schedule_type: 'once',
    schedule_value: new Date().toISOString(),
    context_mode: pipeline.context_mode,
    next_run: new Date().toISOString(),
    status: 'active',
    created_at: new Date().toISOString(),
    pipeline_id: pipeline.id,
    pipeline_step: stepIndex,
  });

  // Update step state
  step.status = 'running';
  step.started_at = new Date().toISOString();
  step.task_id = taskId;
  pipeline.current_step = stepIndex;
  writePipeline(pipeline);

  logger.info(
    { pipelineId: pipeline.id, step: stepIndex, taskId },
    'Pipeline step scheduled',
  );

  return taskId;
}

export function createPipeline(opts: {
  name: string;
  group_folder: string;
  chat_jid: string;
  steps: Array<{ name: string; prompt: string }>;
  context_mode?: 'isolated' | 'group';
  notify?: boolean;
}): Pipeline {
  const id = `pl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const pipeline: Pipeline = {
    id,
    name: opts.name,
    group_folder: opts.group_folder,
    chat_jid: opts.chat_jid,
    status: 'running',
    current_step: 0,
    context_mode: opts.context_mode || 'isolated',
    notify: opts.notify !== false,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    steps: opts.steps.map((s) => ({
      name: s.name,
      prompt: s.prompt,
      status: 'pending' as const,
      result: null,
      error: null,
      started_at: null,
      completed_at: null,
      task_id: null,
    })),
  };

  writePipeline(pipeline);

  // Schedule the first step
  scheduleStep(pipeline, 0);

  logger.info(
    { pipelineId: id, name: opts.name, stepCount: opts.steps.length },
    'Pipeline created',
  );

  return pipeline;
}

/**
 * Called when a pipeline step task completes.
 * Updates pipeline state and schedules the next step.
 * Returns a notification message if one should be sent, or null.
 */
export function advancePipeline(
  pipelineId: string,
  groupFolder: string,
  stepIndex: number,
  result: string | null,
  error: string | null,
): string | null {
  const pipeline = readPipeline(groupFolder, pipelineId);
  if (!pipeline) {
    logger.warn(
      { pipelineId, groupFolder },
      'Pipeline not found for advancement',
    );
    return null;
  }

  const step = pipeline.steps[stepIndex];
  if (!step) {
    logger.warn({ pipelineId, stepIndex }, 'Pipeline step not found');
    return null;
  }

  // If pipeline was paused or cancelled while step was running, don't advance
  if (pipeline.status !== 'running') {
    logger.info(
      { pipelineId, status: pipeline.status },
      'Pipeline no longer running, skipping advancement',
    );
    step.status = error ? 'failed' : 'completed';
    step.result = result;
    step.error = error;
    step.completed_at = new Date().toISOString();
    writePipeline(pipeline);
    return null;
  }

  if (error) {
    step.status = 'failed';
    step.error = error;
    step.completed_at = new Date().toISOString();
    pipeline.status = 'failed';
    writePipeline(pipeline);

    logger.info({ pipelineId, stepIndex, error }, 'Pipeline step failed');

    if (pipeline.notify) {
      return `Pipeline "${pipeline.name}" failed at step ${stepIndex + 1}/${pipeline.steps.length} (${step.name}): ${error}`;
    }
    return null;
  }

  step.status = 'completed';
  step.result = result;
  step.completed_at = new Date().toISOString();

  // Check if there are more steps
  const nextStepIndex = stepIndex + 1;
  if (nextStepIndex >= pipeline.steps.length) {
    pipeline.status = 'completed';
    writePipeline(pipeline);

    logger.info({ pipelineId }, 'Pipeline completed');

    if (pipeline.notify) {
      const stepSummaries = pipeline.steps
        .map(
          (s, i) => `${i + 1}. ${s.name}: ${s.result?.slice(0, 100) || 'done'}`,
        )
        .join('\n');
      return `Pipeline "${pipeline.name}" completed!\n\n${stepSummaries}`;
    }
    return null;
  }

  // Schedule next step
  writePipeline(pipeline);
  scheduleStep(pipeline, nextStepIndex);

  logger.info(
    { pipelineId, completedStep: stepIndex, nextStep: nextStepIndex },
    'Pipeline advancing to next step',
  );

  if (pipeline.notify) {
    return `Pipeline "${pipeline.name}" — step ${stepIndex + 1}/${pipeline.steps.length} (${step.name}) completed. Starting step ${nextStepIndex + 1} (${pipeline.steps[nextStepIndex].name})...`;
  }
  return null;
}

export function pausePipeline(
  groupFolder: string,
  pipelineId: string,
): boolean {
  const pipeline = readPipeline(groupFolder, pipelineId);
  if (!pipeline || pipeline.status !== 'running') return false;
  pipeline.status = 'paused';
  writePipeline(pipeline);
  logger.info({ pipelineId }, 'Pipeline paused');
  return true;
}

export function resumePipeline(
  groupFolder: string,
  pipelineId: string,
): string | null {
  const pipeline = readPipeline(groupFolder, pipelineId);
  if (!pipeline || pipeline.status !== 'paused') return null;

  pipeline.status = 'running';

  // Find the next pending step to schedule
  const nextStepIndex = pipeline.steps.findIndex((s) => s.status === 'pending');
  if (nextStepIndex === -1) {
    pipeline.status = 'completed';
    writePipeline(pipeline);
    logger.info(
      { pipelineId },
      'Pipeline resumed but no pending steps — completed',
    );
    return null;
  }

  writePipeline(pipeline);
  const taskId = scheduleStep(pipeline, nextStepIndex);
  logger.info({ pipelineId, nextStep: nextStepIndex }, 'Pipeline resumed');
  return taskId;
}

export function cancelPipeline(
  groupFolder: string,
  pipelineId: string,
): boolean {
  const pipeline = readPipeline(groupFolder, pipelineId);
  if (!pipeline) return false;
  if (pipeline.status === 'completed' || pipeline.status === 'failed')
    return false;

  for (const step of pipeline.steps) {
    if (step.status === 'pending' || step.status === 'running') {
      step.status = 'skipped';
    }
  }

  pipeline.status = 'failed';
  writePipeline(pipeline);
  logger.info({ pipelineId }, 'Pipeline cancelled');
  return true;
}
