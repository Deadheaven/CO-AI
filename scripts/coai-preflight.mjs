import { spawnSync } from "node:child_process";
import fs from "node:fs";
import process from "node:process";

const live = process.argv.includes("--live");
const migrationVersions = Array.from({ length: 16 }, (_, index) =>
  String(index + 1).padStart(4, "0"),
);
const localMigrations = fs.readdirSync("supabase/migrations");
const missingLocalMigrations = migrationVersions.filter((version) =>
  !localMigrations.some((file) => file.startsWith(`${version}_`)),
);

function envNamesFromFile(path) {
  if (!fs.existsSync(path)) return new Set();
  const names = new Set();
  for (const line of fs.readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    const value = match[2].replace(/^(["'])(.*)\1$/, "$2").trim();
    const placeholder = /(?:^|[./_-])(?:replace-with-|your-)|example\.(?:com|org|net)/i.test(value);
    if (value && !placeholder) {
      names.add(match[1]);
    }
  }
  return names;
}

function envValue(name, paths) {
  if (process.env[name] !== undefined) return process.env[name];
  for (const path of paths) {
    if (!fs.existsSync(path)) continue;
    for (const line of fs.readFileSync(path, "utf8").split(/\r?\n/)) {
      const match = line.match(new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=\\s*(.*?)\\s*$`));
      if (match) return match[1].replace(/^("|')(.*)\1$/, "$2").trim();
    }
  }
  return undefined;
}

function parseCliJson(stdout) {
  try {
    return JSON.parse(stdout.trim());
  } catch {
    return null;
  }
}

function listItems(value, key) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.[key])) return value[key];
  return null;
}

function hasSitesStaticManifest() {
  try {
    const manifest = JSON.parse(fs.readFileSync(".openai/hosting.json", "utf8"));
    return typeof manifest.project_id === "string" &&
      typeof manifest.static?.directory === "string";
  } catch {
    return false;
  }
}

function supabaseCli(args) {
  const result = spawnSync("npx", ["supabase", ...args], {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) return null;
  return parseCliJson(result.stdout ?? "");
}

function report(label, missing) {
  console.log(`${label}: ${missing.length ? `missing ${missing.join(", ")}` : "ready"}`);
  if (missing.length) process.exitCode = 1;
}

function main() {
  console.log(`CO-AI preflight (${live ? "linked deployment" : "local"})`);
  console.log(
    `local migrations: ${missingLocalMigrations.length ? `missing ${missingLocalMigrations.join(", ")}` : "0001-0016 present"}`,
  );
  if (missingLocalMigrations.length) process.exitCode = 1;

  if (!live) {
    console.log("Live checks skipped (pass --live to inspect local config and linked Supabase state).");
    return;
  }

  const shellNames = new Set(
    Object.entries(process.env).filter(([, value]) => Boolean(value)).map(([key]) => key),
  );
  const browserNames = new Set([
    ...shellNames,
    ...envNamesFromFile(".env.local"),
    ...envNamesFromFile(".env.nebius"),
  ]);
  const workerNames = new Set([...shellNames, ...envNamesFromFile("worker/.env.worker")]);
  report("browser config", [
    ...["VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY"].filter((name) => !browserNames.has(name)),
  ]);
  const publicDemoValue = envValue("VITE_COAI_PUBLIC_DEMO", [".env.local", ".env.nebius"]);
  report("public demo frontend mode", publicDemoValue === "true" ? [] : ["VITE_COAI_PUBLIC_DEMO=true"]);
  if (hasSitesStaticManifest()) {
    console.log("frontend host config: Sites static manifest present (COAI_DOMAIN not required)");
  } else {
    report("combined Nebius frontend config", [
      ...["COAI_DOMAIN"].filter((name) => !browserNames.has(name)),
    ]);
  }
  report("worker host config", [
    ...[
      "SUPABASE_URL",
      "SUPABASE_SERVICE_ROLE_KEY",
      "NEBIUS_SANDBOX_BASE_URL",
      "NEBIUS_PROJECT_ID",
      "NEBIUS_SANDBOX_IMAGE",
    ].filter((name) => !workerNames.has(name)),
    ...(!workerNames.has("NEBIUS_API_KEY") && !workerNames.has("NEBIUS_IAM_TOKEN") ? ["NEBIUS_API_KEY (or legacy NEBIUS_IAM_TOKEN)"] : []),
  ]);

  const projectRefPath = "supabase/.temp/project-ref";
  const projectRef = process.env.SUPABASE_PROJECT_REF ||
    (fs.existsSync(projectRefPath) ? fs.readFileSync(projectRefPath, "utf8").trim() : "");
  if (!projectRef) {
    console.log("linked Supabase: unavailable (project reference not found)");
    process.exitCode = 1;
    return;
  }

  const secrets = supabaseCli(["secrets", "list", "--project-ref", projectRef, "--output", "json"]);
  const secretItems = listItems(secrets, "secrets");
  if (!secretItems) {
    console.log("Supabase function secrets: unavailable (CLI auth or network check failed)");
    process.exitCode = 1;
  } else {
    const names = new Set(secretItems.map((secret) => secret.name));
    const missing = [];
    if (!names.has("nebius") && !names.has("NEBIUS_API_KEY")) {
      missing.push("nebius (or legacy NEBIUS_API_KEY)");
    }
    if (!names.has("COAI_LLM_PROVIDER")) missing.push("COAI_LLM_PROVIDER=nebius");
    if (!names.has("COAI_PUBLIC_DEMO")) missing.push("COAI_PUBLIC_DEMO=true");
    report("Supabase function secrets", missing);
  }

  const migrations = supabaseCli(["migration", "list", "--linked", "--output-format", "json"]);
  const migrationItems = listItems(migrations, "migrations");
  if (!migrationItems) {
    console.log("remote migrations: unavailable (CLI auth or network check failed)");
    process.exitCode = 1;
  } else {
    const mismatched = migrationVersions.filter((version) =>
      !migrationItems.some((entry) => entry.local === version && entry.remote === version),
    );
    report("remote migrations", mismatched.length ? mismatched : []);
  }

  const functions = supabaseCli(["functions", "list", "--project-ref", projectRef, "--output", "json"]);
  const functionItems = listItems(functions, "functions");
  if (!functionItems) {
    console.log("Edge Functions: unavailable (CLI auth or network check failed)");
    process.exitCode = 1;
  } else {
    const active = new Set(
      functionItems.filter((fn) => fn.status === "ACTIVE").map((fn) => fn.slug),
    );
    report("Edge Functions", [
      ...["coai-agent", "coai-gh", "coai-replay"].filter((name) => !active.has(name)),
    ]);
  }
}

main();
