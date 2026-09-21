import fs from "node:fs";
import process from "node:process";

const live = process.argv.includes("--live");
const migrationFiles = Array.from(
  { length: 10 },
  (_, index) => `${String(index + 1).padStart(4, "0")}_`,
);
const requiredFiles = migrationFiles.map((prefix) => [
  prefix,
  fs.readdirSync("supabase/migrations").some((file) => file.startsWith(prefix)),
]);
const requiredEnv = [
  ["VITE_SUPABASE_URL", process.env.VITE_SUPABASE_URL],
  ["VITE_SUPABASE_ANON_KEY", process.env.VITE_SUPABASE_ANON_KEY],
  ["SUPABASE_URL", process.env.SUPABASE_URL],
  ["SUPABASE_SERVICE_ROLE_KEY", process.env.SUPABASE_SERVICE_ROLE_KEY],
  [
    "NVIDIA_API_KEY or LLM_API_KEY",
    process.env.NVIDIA_API_KEY || process.env.LLM_API_KEY,
  ],
  [
    "GITHUB_PAT or GITHUB_APP_ID",
    process.env.GITHUB_PAT || process.env.GITHUB_APP_ID,
  ],
  ["NEBIUS_SANDBOX_BASE_URL", process.env.NEBIUS_SANDBOX_BASE_URL],
  ["NEBIUS_IAM_TOKEN", process.env.NEBIUS_IAM_TOKEN],
  ["NEBIUS_PROJECT_ID", process.env.NEBIUS_PROJECT_ID],
  ["NEBIUS_SANDBOX_IMAGE", process.env.NEBIUS_SANDBOX_IMAGE],
];
const missingFiles = requiredFiles
  .filter(([, present]) => !present)
  .map(([name]) => name);
const missingEnv = live
  ? requiredEnv.filter(([, value]) => !value).map(([name]) => name)
  : [];
console.log(`CO-AI preflight (${live ? "live" : "local"})`);
console.log(
  `migrations: ${missingFiles.length ? `missing ${missingFiles.join(", ")}` : "0001-0010 present"}`,
);
if (live)
  console.log(
    `secrets: ${missingEnv.length ? `missing ${missingEnv.join(", ")}` : "all required names present"}`,
  );
else
  console.log(
    "secrets: skipped (use --live to validate names without printing values)",
  );
if (missingFiles.length || missingEnv.length) process.exitCode = 1;
