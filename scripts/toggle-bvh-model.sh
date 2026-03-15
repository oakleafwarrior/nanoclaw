#!/bin/bash
set -e

export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
DB="/Users/aolhava/Desktop/nanoclaw/store/messages.db"
SETTINGS="/Users/aolhava/Desktop/nanoclaw/data/sessions/blood_vessel_hypoxia/.claude/settings.json"

CURRENT=$(node -e "
const db = require('better-sqlite3')('$DB');
const row = db.prepare(\"SELECT container_config FROM registered_groups WHERE folder = 'blood_vessel_hypoxia'\").get();
console.log(JSON.parse(row.container_config).model);
")

if [ "$CURRENT" = "claude-sonnet-4-6" ]; then
  NEW="claude-opus-4-6"
else
  NEW="claude-sonnet-4-6"
fi

node -e "
const db = require('better-sqlite3')('$DB');
const row = db.prepare(\"SELECT container_config FROM registered_groups WHERE folder = 'blood_vessel_hypoxia'\").get();
const config = JSON.parse(row.container_config);
config.model = '$NEW';
db.prepare(\"UPDATE registered_groups SET container_config = ? WHERE folder = 'blood_vessel_hypoxia'\").run(JSON.stringify(config));
"

rm -f "$SETTINGS"

echo "blood-vessel-hypoxia: $CURRENT → $NEW"
