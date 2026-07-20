/**
 * Alert templates — tasteful defaults, not a hardcoded growth engine.
 * Cadence / hooks / CTA rotation are tuned post-deploy via TWEET_STYLE + copy env.
 */

function disclaimer(config, { short = false } = {}) {
  return short ? config.legal.shortDisclaimer : config.legal.disclaimer;
}

function formatTelegram(config, alert, { premium }) {
  const brand = config.brand;
  const lines = [
    `🛡 *${escMd(brand)} ${premium ? 'PREMIUM' : 'ALERT'}*`,
    `*${escMd(alert.title)}*`,
    '',
    escMd(alert.body),
  ];
  if (alert.fields?.length) {
    lines.push('');
    for (const f of alert.fields) {
      lines.push(`• *${escMd(f.label)}:* ${escMd(String(f.value))}`);
    }
  }
  if (alert.url) lines.push('', `[Open](${alert.url})`);
  if (alert.monetization?.affiliateUrl) {
    lines.push(
      '',
      `[${escMd(alert.monetization.affiliateLabel)}](${alert.monetization.affiliateUrl})`
    );
  }
  if (!premium && alert.monetization?.upgradeUrl) {
    lines.push('', `[Upgrade to Premium](${alert.monetization.upgradeUrl})`);
  }
  lines.push('', `_${escMd(disclaimer(config, { short: true }))}_`);
  return lines.join('\n');
}

function formatTweet(config, alert) {
  const style = config.growth.tweetStyle || 'compact';
  const upgrade =
    alert.monetization?.tweetUpgradeUrl ||
    config.growth.tweetUpgradeUrl ||
    alert.monetization?.upgradeUrl ||
    '';
  const affiliate = alert.monetization?.affiliateUrl || '';
  const link = upgrade || affiliate || alert.url || '';
  const linkBlock = link ? `\n${link}` : '';
  const foot = `\n${disclaimer(config, { short: true })}`;

  let core;
  if (style === 'minimal') {
    core = `${alert.title}`;
  } else if (style === 'narrative') {
    core = `${config.brand} saw ${alert.title}. ${alert.body}`;
  } else {
    // compact (default) — readable, not spammy
    core = `${config.brand}: ${alert.title}\n${alert.body}`;
  }

  const budget = 280 - linkBlock.length - foot.length;
  if (core.length > budget) core = `${core.slice(0, Math.max(0, budget - 1))}…`;
  return core + linkBlock + foot;
}

function formatDiscord(config, alert) {
  return {
    username: config.brand,
    embeds: [
      {
        title: alert.title,
        description: `${alert.body}\n\n_${disclaimer(config, { short: true })}_`,
        url: alert.monetization?.upgradeUrl || alert.url,
        color: 0x0ea5e9,
        fields: (alert.fields || []).slice(0, 6).map((f) => ({
          name: f.label,
          value: String(f.value).slice(0, 200),
          inline: true,
        })),
        footer: { text: disclaimer(config, { short: true }) },
      },
    ],
  };
}

function escMd(text) {
  return String(text).replace(/([_*`\[])/g, '\\$1');
}

module.exports = {
  disclaimer,
  formatTelegram,
  formatTweet,
  formatDiscord,
};
