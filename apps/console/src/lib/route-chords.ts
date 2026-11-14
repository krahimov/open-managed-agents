/* ── Linear-style chord keybindings (g + letter → route) ──
 *
 * Mapping is path → second key. The prefix is always "g". The letter is the
 * first letter of the destination's name wherever that is free; clashes take
 * the next most meaningful letter:
 *
 *   k  Skills            so API keys uses `i` ("key id")
 *   e  Environments      so Evals uses `l` (eva-L-s)
 *   d  Deployments' natural letter is kept for Home's old chord (below),
 *      so Deployments uses `p` (de-P-loy)
 *   a  Agents            so Apps uses `n` (co-N-nect)
 *
 * Every destination in the sidebar has a chord except the three third-party
 * integration pages (Slack, GitHub, Linear), which are one step from Apps.
 * The command palette prints the chord beside each destination.
 *
 * ROUTE_CHORD_ALIASES are older chords that still work but are not printed:
 * Home was "Dashboard" (g d) before it was Home (g h).
 *
 * Exported here (not in AppShell) so the palette and the shell read the same
 * map without importing each other. */
export const ROUTE_CHORDS: Record<string, string> = {
  "/":                  "h",
  "/agents":            "a",
  "/sessions":          "s",
  "/operations":        "o",
  "/deployments":       "p",
  "/evals":             "l",
  "/usage":             "u",
  "/files":             "f",
  "/skills":            "k",
  "/memory":            "m",
  "/environments":      "e",
  "/vaults":            "v",
  "/model-cards":       "c",
  "/integrations/apps": "n",
  "/runtimes":          "r",
  "/api-keys":          "i",
  "/workspace":         "w",
};

/** Still honoured, never shown. */
export const ROUTE_CHORD_ALIASES: Record<string, string> = {
  "/": "d",
};
