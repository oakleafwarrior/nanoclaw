import { describe, it, expect } from 'vitest';
import { classifyMessages, resolveModel } from './model-router.js';
import type { RegisteredGroup } from './types.js';

function msg(content: string) {
  return { content };
}

function makeGroup(overrides: Partial<RegisteredGroup> = {}): RegisteredGroup {
  return {
    name: 'test',
    folder: 'test',
    trigger: '@Bot',
    added_at: '2026-01-01',
    containerConfig: { model: 'claude-sonnet-4-6' },
    ...overrides,
  };
}

describe('classifyMessages', () => {
  it('routes hypothesis generation to opus', () => {
    const result = classifyMessages([
      msg(
        'propose an experiment to test the hypothesis that HIF1α drives EMT under chronic hypoxia via the signaling pathway between VEGF and HIF',
      ),
    ]);
    expect(result.tier).toBe('opus');
    expect(result.opusScore).toBeGreaterThanOrEqual(4);
  });

  it('routes experimental design to opus', () => {
    const result = classifyMessages([
      msg(
        'design an experiment to test whether HIF1α drives endothelial-to-mesenchymal transition under chronic hypoxia',
      ),
    ]);
    expect(result.tier).toBe('opus');
  });

  it('routes complex analysis requests to opus', () => {
    const result = classifyMessages([
      msg(
        'critically analyze the signaling pathway between VEGF and HIF1α transcriptional regulation in hypoxic endothelial cells',
      ),
    ]);
    expect(result.tier).toBe('opus');
  });

  it('routes systematic review to opus', () => {
    const result = classifyMessages([
      msg(
        'provide a comprehensive systematic review of epigenetic mechanisms in endothelial-to-mesenchymal transition',
      ),
    ]);
    expect(result.tier).toBe('opus');
  });

  it('routes "what is VEGF?" to haiku', () => {
    const result = classifyMessages([msg('what is VEGF?')]);
    expect(result.tier).toBe('haiku');
    expect(result.haikuScore).toBeGreaterThanOrEqual(3);
  });

  it('routes simple definitions to haiku', () => {
    const result = classifyMessages([msg('define apoptosis')]);
    expect(result.tier).toBe('haiku');
  });

  it('routes thanks/acknowledgments to haiku', () => {
    const result = classifyMessages([msg('thanks')]);
    expect(result.tier).toBe('haiku');
  });

  it('routes standard analysis to sonnet (default)', () => {
    const result = classifyMessages([
      msg(
        'run differential expression analysis on the hypoxia vs normoxia clusters',
      ),
    ]);
    expect(result.tier).toBe('sonnet');
  });

  it('routes ambiguous messages to sonnet', () => {
    const result = classifyMessages([
      msg('can you look at the gene expression data and tell me what you find'),
    ]);
    expect(result.tier).toBe('sonnet');
  });

  it('gives last message 1.5x weight', () => {
    // First message is haiku-tier, but last message has opus signals
    const result = classifyMessages([
      msg('what is VEGF?'),
      msg(
        'now design an experiment to test the hypothesis that VEGF drives angiogenesis',
      ),
    ]);
    expect(result.tier).toBe('opus');
  });

  it('returns sonnet for empty messages', () => {
    const result = classifyMessages([]);
    expect(result.tier).toBe('sonnet');
    expect(result.opusScore).toBe(0);
    expect(result.haikuScore).toBe(0);
  });

  it('adds length bonus for long last messages', () => {
    const shortResult = classifyMessages([msg('analyze this')]);
    const longContent = 'analyze this pathway: ' + 'x'.repeat(200);
    const longResult = classifyMessages([msg(longContent)]);
    expect(longResult.opusScore).toBeGreaterThan(shortResult.opusScore);
  });
});

describe('resolveModel', () => {
  it('returns current model when autoRoute is disabled', () => {
    const group = makeGroup({
      containerConfig: { model: 'claude-opus-4-6' },
    });
    const result = resolveModel(group, [msg('design an experiment')]);
    expect(result.autoRouted).toBe(false);
    expect(result.modelId).toBe('claude-opus-4-6');
  });

  it('returns current model when modelPinned is true', () => {
    const group = makeGroup({
      containerConfig: {
        model: 'claude-sonnet-4-6',
        autoRoute: true,
        modelPinned: true,
      },
    });
    const result = resolveModel(group, [
      msg('design an experiment to test the hypothesis'),
    ]);
    expect(result.autoRouted).toBe(false);
    expect(result.modelId).toBe('claude-sonnet-4-6');
  });

  it('auto-routes to opus when enabled and score is high', () => {
    const group = makeGroup({
      containerConfig: { model: 'claude-sonnet-4-6', autoRoute: true },
    });
    const result = resolveModel(group, [
      msg(
        'design an experiment to test the hypothesis that HIF1α drives endothelial-to-mesenchymal transition',
      ),
    ]);
    expect(result.autoRouted).toBe(true);
    expect(result.tier).toBe('opus');
    expect(result.modelId).toBe('claude-opus-4-6');
  });

  it('auto-routes to haiku for simple lookups', () => {
    const group = makeGroup({
      containerConfig: { model: 'claude-sonnet-4-6', autoRoute: true },
    });
    const result = resolveModel(group, [msg('what is VEGF?')]);
    expect(result.autoRouted).toBe(true);
    expect(result.tier).toBe('haiku');
    expect(result.modelId).toBe('claude-haiku-4-5-20251001');
  });

  it('stays on sonnet for standard analysis', () => {
    const group = makeGroup({
      containerConfig: { model: 'claude-sonnet-4-6', autoRoute: true },
    });
    const result = resolveModel(group, [
      msg('run differential expression analysis on the clusters'),
    ]);
    expect(result.autoRouted).toBe(false);
    expect(result.tier).toBe('sonnet');
    expect(result.modelId).toBe('claude-sonnet-4-6');
  });

  it('defaults to sonnet when no model is set in config', () => {
    const group = makeGroup({
      containerConfig: { autoRoute: true },
    });
    const result = resolveModel(group, [msg('hello')]);
    expect(result.modelId).toBe('claude-sonnet-4-6');
  });

  it('defaults to sonnet when containerConfig is undefined', () => {
    const group = makeGroup({ containerConfig: undefined });
    const result = resolveModel(group, [msg('hello')]);
    expect(result.autoRouted).toBe(false);
    expect(result.modelId).toBe('claude-sonnet-4-6');
  });
});
