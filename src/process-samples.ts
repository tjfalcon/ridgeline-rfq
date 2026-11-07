import { readFile, mkdir, writeFile, appendFile } from 'node:fs/promises';
import { loadReporting, processDrafts } from './routing.ts';
import { loadRules } from './config.ts';
const root = new URL('../', import.meta.url);
// CLI processing has its own append-only audit so it cannot overwrite API workflow
// state. These are calculated routing results, not human approval decisions.
const audit = async (action: string, quoteId: string | null, after: unknown) => {
  await mkdir(new URL('var/', root), { recursive: true });
  await appendFile(new URL('var/processing-audit.jsonl', root), JSON.stringify({ actor: 'sample-processor', action, quote_id: quoteId, timestamp: new Date().toISOString(), before: null, after }) + '\n');
};
try {
  await audit('sample_processing_started', null, null);
  const rules = await loadRules(new URL('config/approval-rules.json', root));
  const { drafts } = JSON.parse(await readFile(new URL('data-pack_platform/draft_quotes.json', root), 'utf8'));
  const reporting = await loadReporting(new URL('data-pack_platform/reporting_db/', root));
  const results = await processDrafts(drafts, reporting, rules);
  for (const result of results) await audit('sample_draft_processed', result.draft_id, result);
  await mkdir(new URL('outputs/', root), { recursive: true });
  await writeFile(new URL('outputs/routing_results.json', root), JSON.stringify(results, null, 2) + '\n');
  await audit('routing_output_written', null, { count: results.length });
  console.table(results.map(({ draft_id, status, net_total, effective_discount_pct, approver_id, duplicate_of }) => ({ draft_id, status, net_total, effective_discount_pct, approver_id, duplicate_of })));
  console.log('Wrote outputs/routing_results.json. Routes only: every quote still needs human approval.');
} catch (error) {
  await audit('sample_processing_failed', null, null);
  console.error(error instanceof Error ? error.message : error); process.exitCode = 1;
}
