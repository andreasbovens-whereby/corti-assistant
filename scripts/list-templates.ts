// Lists the Corti note templates available to this tenant.
// Usage: npm run list-templates [-- <language>]
//
// Corti has two template systems (see NOTES.md):
//   - classic templates, referenced by `key`, used by documents.classic.create()
//   - guided templates, referenced by UUID, used by documents.generate()
import "dotenv/config";
import { CortiClient } from "@corti/sdk";

const required = ["CORTI_TENANT", "CORTI_CLIENT_ID", "CORTI_CLIENT_SECRET"] as const;
const missing = required.filter((name) => !process.env[name]);
if (missing.length > 0) {
  console.error(`Missing ${missing.join(", ")}. Copy .env.example to .env and fill it in.`);
  process.exit(1);
}

const lang = process.argv[2];
const client = new CortiClient({
  tenantName: process.env.CORTI_TENANT!,
  environment: process.env.CORTI_ENV ?? "eu",
  auth: { clientId: process.env.CORTI_CLIENT_ID!, clientSecret: process.env.CORTI_CLIENT_SECRET! },
});

const classic = await client.templates.list(lang ? { lang } : {});
console.log(`Classic templates (${classic.data.length}), use the key as NOTE_TEMPLATE_KEY:`);
for (const t of classic.data) {
  const languages = t.translations.map((tr) => tr.languageId).join(", ") || "-";
  console.log(`  ${t.key}  [${t.status}]  ${t.name}  (languages: ${languages})`);
}

const guided = await client.documents.templates.list(lang ? { lang } : {});
console.log(`\nGuided templates (${guided.length}), referenced by id:`);
for (const t of guided) {
  console.log(`  ${t.id}  [${t.source ?? "-"}]  ${t.name}  (languages: ${t.languages.join(", ") || "any"})`);
}
