/**
 * One-off: create the GitHub release v2.2.0 for skchopper/meat with curated, feature-only notes.
 * Run after the release commit is pushed. Requires GH_TOKEN.
 */
const body = `# MEAT v2.2.0 — Trading-hours monitoring & tiered execution cadence

**MEAT — Mortality Engineered Auto-Trading** is a multi-agent paper-trading system built on Mortality Engineering: six roles with stoplines, a death rule, replication with exactly one mutation, an external Reaper, isolated per-agent research, and an operator control panel. Paper trading by default; live trading is triple-gated. Not investment advice.

## Highlights

- **Two execution cadences per bot.** Day-trading bots are analysed and trade every minute on 1-minute bars; mid/long-term bots run hourly on 1-hour bars. Each bot has an execution tier (\`day\` / \`swing\`), children inherit their parent's tier, and both tiers are configurable (interval + timeframe).
- **Price monitoring only during trading hours.** Outside market sessions the engine runs a lightweight maintenance pass — research sidecar plus status only — with no market-data consumption and no per-cycle operating charges.
- **Positions are never left unmanaged between slow decisions.** A swing-tier bot holding a position receives an exit-only risk pass every cycle: stop-loss, take-profit, max-hold and adverse-research exits are continuously checked, while new entries still respect the bot's cadence.
- **Timeframe-aware strategy rules.** Bar-based rules — notably \`maxHoldBars\` — are measured in bars of the bot's own timeframe, so a 12-bar stop means 12 minutes for a day bot and 12 hours for a swing bot. Plans and dashboards display each bot's cadence and timeframe.
- **Configurable market data.** Market-data feed (IEX real-time vs consolidated SIP) and bar timeframe are configurable with validated allow-lists.

## Features & changes

- Per-agent execution tiers with inheritance through replication.
- Cadence configuration (\`cadence.day\` / \`cadence.swing\`: interval seconds + timeframe) and a trading-hours gate (\`engine.tradingHoursOnly\`, off-hours interval).
- Exit-only risk passes for held positions between full analyses.
- Status/dashboard additions: per-agent tier and cadence (interval, timeframe, last/next analysis), plus engine cadence settings.
- Timeframe-correct hold logic across the executor and the strategy plan descriptions.
- Documentation: tiered cadence and trading-hours sections, README and changelog updates.
- Compatibility: the cadence block is optional — without it the engine keeps the previous single-cadence behaviour, and existing agents are tier-assigned on first start.

## Verification

- 227 automated tests across eight suites — mortality, market, plugin, integration, security, research, rankings and control — plus research and defect-regression smoke checks.
`;

(async () => {
  const token = process.env.GH_TOKEN;
  if (!token) throw new Error('GH_TOKEN required');
  const headers = {
    authorization: `Bearer ${token}`,
    'user-agent': 'meat-release',
    accept: 'application/vnd.github+json',
    'content-type': 'application/json',
  };
  const response = await fetch('https://api.github.com/repos/skchopper/meat/releases', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      tag_name: 'v2.2.0',
      target_commitish: 'main',
      name: 'MEAT v2.2.0 — Trading-hours monitoring & tiered execution cadence',
      body,
      draft: false,
      prerelease: false,
    }),
  });
  const text = await response.text();
  if (!response.ok) {
    console.error('release failed', response.status, text.slice(0, 400));
    process.exit(1);
  }
  const release = JSON.parse(text);
  console.log('release:', release.name);
  console.log('url:', release.html_url);
  console.log('tag:', release.tag_name, '| target:', release.target_commitish);
  const tag = await (await fetch(`https://api.github.com/repos/skchopper/meat/git/ref/tags/${release.tag_name}`, { headers })).json();
  console.log('tag object:', tag.object?.type, tag.object?.sha?.slice(0, 8));
})();
