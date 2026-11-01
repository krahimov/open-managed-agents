/**
 * One-line editorial decks shown under list-page titles. Purely
 * presentational — keyed by pathname so DataTable / ListPage can pick
 * them up without every page threading a subtitle prop through.
 */
const DESCRIPTIONS: Record<string, string> = {
  "/agents": "Configurations that define what each assistant can do.",
  "/sessions": "Every conversation between people and agents, with its full event log.",
  "/deployments": "Agents running on a schedule or behind an endpoint.",
  "/files": "Uploads and outputs available to sessions.",
  "/evals": "Suites that score agents against a rubric.",
  "/environments": "Sandboxes: packages, networking and the container image.",
  "/vaults": "Credentials injected at the network edge. Never inside the sandbox.",
  "/skills": "Reusable instructions and files mounted into every session.",
  "/memory": "Persistent stores agents read and write across sessions.",
  "/model-cards": "Providers, endpoints and model settings.",
  "/api-keys": "Keys for the CLI, SDK and your own services.",
  "/runtimes": "Machines you have connected to run agents locally.",
};

export function pageDescription(pathname: string): string | undefined {
  return DESCRIPTIONS[pathname.replace(/\/+$/, "") || "/"];
}
