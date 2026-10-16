import type { CustomRule } from "./rules.js";

// Ready-made guardrails: common security rules every team ends up writing, on from the first install.
// Each pack can be switched off (setting `guardrails_off`), unless the company locked that setting.
// They sit on top of the core protection in the engine (secrets, data leaks, wiping files, the Rule of Two),
// which is always on and cannot be switched off.

export interface Guardrail {
  id: string;
  name: string;
  /** One sentence a developer reads. */
  summary: string;
  /** Two or three concrete examples it stops. */
  examples: string[];
  rules: CustomRule[];
}

const r = (id: string, description: string, kind: CustomRule["kind"], patterns: string[], action: CustomRule["action"], alternative: string): CustomRule => ({
  id,
  description,
  kind,
  patterns,
  action,
  alternative,
});

export const GUARDRAILS: Guardrail[] = [
  {
    id: "cloud-teardown",
    name: "Cloud and infrastructure teardown",
    summary: "Blocks commands that delete cloud resources, clusters or whole environments.",
    examples: ["terraform destroy", "kubectl delete namespace prod", "aws cloudformation delete-stack"],
    rules: [
      r("cloud-destroy", "Deleting cloud infrastructure", "command", [
        "terraform destroy", "terraform apply -destroy", "pulumi destroy", "cdk destroy", "kubectl delete namespace", "kubectl delete ns",
        "helm uninstall", "aws cloudformation delete-stack", "aws ec2 terminate-instances", "aws rds delete-db-instance", "aws s3 rb",
        "gcloud projects delete", "gcloud container clusters delete", "gcloud sql instances delete", "az group delete", "eksctl delete cluster",
      ], "block", "Show the user the plan (for example terraform plan -destroy) and let them run it."),
      r("cloud-bulk-delete", "Deleting a whole storage bucket's contents", "text", ["\\b(aws\\s+s3\\s+rm|gsutil\\s+(-m\\s+)?rm)\\b[^\\n]*\\s(--recursive|-r)\\b"], "block", "List what would be deleted and let the user decide."),
    ],
  },
  {
    id: "database-wipe",
    name: "Database wipes and resets",
    summary: "Blocks commands that drop or reset a database, and asks before connecting to production.",
    examples: ["prisma migrate reset", "dropdb app", "psql $PROD_DATABASE_URL"],
    rules: [
      r("db-reset", "Dropping or resetting a database", "command", [
        "prisma migrate reset", "prisma db push --force-reset", "dropdb", "rails db:drop", "rake db:drop", "rails db:reset", "python manage.py flush",
        "redis-cli flushall",
      ], "block", "Use a local or test database, or ask the user to run it."),
      r("db-production", "Connecting to a production database", "text", ["\\b(psql|mysql|mongosh?|redis-cli|pg_dump|mysqldump)\\b[^\\n]*\\bprod"], "ask", "Use the staging database, or explain to the user why production is needed."),
    ],
  },
  {
    id: "publishing",
    name: "Publishing and releases",
    summary: "Asks before anything is published to a registry or released to users.",
    examples: ["npm publish", "docker push", "gh release create v2.0"],
    rules: [
      r("publish", "Publishing a package or release", "command", [
        "npm publish", "pnpm publish", "yarn publish", "yarn npm publish", "twine upload", "poetry publish", "cargo publish", "gem push",
        "docker push", "gh release create", "mvn deploy", "dotnet nuget push", "vsce publish",
      ], "ask", "Prepare the release and let the user publish it."),
    ],
  },
  {
    id: "git-history",
    name: "Rewriting git history",
    summary: "Asks before history is rewritten or remote branches are deleted.",
    examples: ["git filter-branch", "git push origin --delete main", "git reset --hard origin/main"],
    rules: [
      r("git-rewrite", "Rewriting git history or deleting remote branches", "command", [
        "git filter-branch", "git filter-repo", "git push --delete", "git push origin --delete", "git reset --hard origin", "git rebase --root",
      ], "ask", "Explain the change to the user and let them run it."),
    ],
  },
  {
    id: "credentials",
    name: "Printing credentials",
    summary: "Blocks commands that print tokens or passwords into the agent's context.",
    examples: ["gcloud auth print-access-token", "gh auth token", "kubectl config view --raw"],
    rules: [
      r("print-token", "Printing a credential", "command", [
        "gcloud auth print-access-token", "gcloud auth print-identity-token", "gcloud auth application-default print-access-token", "gh auth token",
        "aws configure get aws_secret_access_key", "aws sts get-session-token", "aws ecr get-login-password", "az account get-access-token",
        "kubectl config view --raw", "security find-generic-password", "security find-internet-password", "heroku auth:token", "doctl auth token",
      ], "block", "Use the credential through its tool (for example gcloud or gh) instead of printing it."),
      r("secret-manager", "Reading from a secret manager", "command", ["vault read", "vault kv get", "op read", "op item get", "aws secretsmanager get-secret-value", "gcloud secrets versions access"], "ask", "Tell the user which secret is needed; do not print its value."),
    ],
  },
  {
    id: "system",
    name: "System-wide changes",
    summary: "Blocks wide-open permissions and asks before changing ownership or system settings.",
    examples: ["chmod -R 777 .", "chown -R root /usr/local", "defaults write com.apple.screensaver"],
    rules: [
      r("world-writable", "Making files writable by everyone", "text", ["\\bchmod\\s+(-R\\s+)?(0?777|a\\+rwx)\\b"], "block", "Grant only the permission needed, for example chmod u+x script.sh."),
      r("system-change", "Changing ownership or system settings", "command", ["chown -r", "defaults write", "networksetup", "scutil --set", "netsh", "set-executionpolicy"], "ask", "Explain the change to the user and let them make it."),
    ],
  },
];

export const GUARDRAIL_IDS = GUARDRAILS.map((g) => g.id);

/** The rules of every pack that is not switched off, each tagged with its pack. */
export function guardrailRules(off: readonly string[]): (CustomRule & { source: string; pack: string })[] {
  return GUARDRAILS.filter((g) => !off.includes(g.id)).flatMap((g) => g.rules.map((rule) => ({ ...rule, source: "guardrail", pack: g.name })));
}
