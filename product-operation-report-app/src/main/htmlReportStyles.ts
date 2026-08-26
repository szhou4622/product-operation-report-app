export interface ReportThemeTokens {
  paper: string
  paperAlt: string
  surface: string
  ink: string
  inkSoft: string
  muted: string
  line: string
  lineStrong: string
  accent: string
  accentStrong: string
  accentSoft: string
  series1: string
  series2: string
  series3: string
  series4: string
  warning: string
  warningSoft: string
  radius: string
  shadow: string
  fontDisplay: string
  fontBody: string
  fontData: string
}

function renderTokenBlock(tokens: ReportThemeTokens): string {
  return `:root {
    color-scheme: light;
    --paper: ${tokens.paper};
    --paper-alt: ${tokens.paperAlt};
    --surface: ${tokens.surface};
    --ink: ${tokens.ink};
    --ink-soft: ${tokens.inkSoft};
    --muted: ${tokens.muted};
    --line: ${tokens.line};
    --line-strong: ${tokens.lineStrong};
    --accent: ${tokens.accent};
    --accent-strong: ${tokens.accentStrong};
    --accent-soft: ${tokens.accentSoft};
    --series-1: ${tokens.series1};
    --series-2: ${tokens.series2};
    --series-3: ${tokens.series3};
    --series-4: ${tokens.series4};
    --series-5: var(--accent-strong);
    --series-6: var(--ink-soft);
    --warning: ${tokens.warning};
    --warning-soft: ${tokens.warningSoft};
    --radius: ${tokens.radius};
    --page-shadow: ${tokens.shadow};
    --font-display: ${tokens.fontDisplay};
    --font-body: ${tokens.fontBody};
    --font-data: ${tokens.fontData};
    --print-paper: #fff;
    --content-pad: clamp(24px, 5vw, 72px);
  }`
}

export function renderReportStyles(tokens: ReportThemeTokens): string {
  return `${renderTokenBlock(tokens)}
  * { box-sizing: border-box; }
  html, body { max-width: 100%; overflow-x: clip; }
  html { scroll-behavior: smooth; }
  body {
    margin: 0;
    color: var(--ink);
    background:
      linear-gradient(90deg, transparent 0, transparent calc(50% - 1px), rgb(255 255 255 / .24) 50%, transparent calc(50% + 1px)),
      var(--paper);
    font-family: var(--font-body);
    font-size: 16px;
    line-height: 1.72;
    text-rendering: optimizeLegibility;
  }
  a { color: var(--accent-strong); text-underline-offset: 3px; }
  .report p, .report a, .report li, .report td, .report dd, .toc a {
    overflow-wrap: anywhere;
    word-break: break-word;
  }
  a:focus-visible, summary:focus-visible {
    outline: 3px solid var(--accent);
    outline-offset: 3px;
  }
  .skip-link {
    position: fixed;
    z-index: 30;
    top: 8px;
    left: 8px;
    padding: 10px 14px;
    transform: translateY(-160%);
    background: var(--surface);
    color: var(--ink);
    border: 2px solid var(--accent);
  }
  .skip-link:focus { transform: translateY(0); }
  .shell {
    display: grid;
    grid-template-columns: minmax(190px, 240px) minmax(0, 1fr);
    gap: clamp(16px, 2vw, 32px);
    width: min(1540px, calc(100vw - 48px));
    margin: 24px auto 56px;
    align-items: start;
  }
  .toc {
    position: sticky;
    top: 24px;
    max-height: calc(100vh - 48px);
    overflow: auto;
    padding: 22px 16px;
    background: rgb(255 255 255 / .66);
    border: 1px solid var(--line);
    border-top: 5px solid var(--accent);
    border-radius: var(--radius);
  }
  .toc-title {
    margin: 0 8px 12px;
    color: var(--ink);
    font: 750 15px/1.4 var(--font-display);
  }
  .toc a {
    display: block;
    padding: 8px;
    color: var(--ink-soft);
    text-decoration: none;
    font-size: 13px;
    line-height: 1.45;
  }
  .toc a:hover { color: var(--accent-strong); background: var(--accent-soft); }
  .toc .level-3 { padding-left: 22px; color: var(--muted); }
  .report {
    min-width: 0;
    background: var(--surface);
    box-shadow: var(--page-shadow);
    border-radius: var(--radius);
    overflow: hidden;
  }
  h1, h2, h3, h4 {
    min-width: 0;
    font-family: var(--font-display);
    overflow-wrap: anywhere;
  }
  .story-stat-hero {
    min-height: min(760px, calc(100dvh - 48px));
    padding: clamp(26px, 4.6vw, 68px) var(--content-pad) clamp(34px, 5vw, 72px);
    border-top: 10px solid var(--accent);
    background:
      radial-gradient(circle at 8% 8%, var(--accent-soft), transparent 34%),
      linear-gradient(150deg, var(--surface) 58%, var(--paper-alt));
  }
  .story-stat-hero__meta {
    display: flex;
    justify-content: space-between;
    gap: 24px;
    padding-bottom: 20px;
    color: var(--muted);
    border-bottom: 1px solid var(--line-strong);
    font-size: 13px;
  }
  .story-stat-hero__grid {
    display: grid;
    grid-template-columns: minmax(260px, .8fr) minmax(0, 1.2fr);
    gap: clamp(36px, 6vw, 96px);
    min-height: 430px;
    align-items: center;
  }
  .hero-figure {
    display: flex;
    min-width: 0;
    flex-direction: column;
    justify-content: center;
  }
  .hero-figure strong {
    color: var(--accent-strong);
    font: 800 clamp(64px, 9vw, 126px)/.9 var(--font-data);
    letter-spacing: -.07em;
    white-space: nowrap;
  }
  .hero-figure--audience strong {
    max-width: 12em;
    font: 850 clamp(28px, 4.2vw, 54px)/1.08 var(--font-display);
    letter-spacing: -.035em;
    white-space: normal;
    overflow-wrap: anywhere;
  }
  .hero-figure span {
    max-width: 28ch;
    margin-top: 22px;
    color: var(--ink);
    font: 750 clamp(18px, 2vw, 25px)/1.35 var(--font-display);
  }
  .hero-figure small {
    max-width: 42ch;
    margin-top: 10px;
    color: var(--muted);
    font-size: 12px;
  }
  .hero-figure--text strong {
    font: 800 clamp(38px, 5vw, 68px)/1.02 var(--font-display);
    letter-spacing: -.04em;
    white-space: normal;
  }
  .hero-figure--text span {
    color: var(--muted);
    font-size: 15px;
    font-weight: 500;
  }
  .hero-copy h1 {
    max-width: 18ch;
    margin: 0;
    font-size: clamp(36px, 5.4vw, 72px);
    line-height: 1.06;
    letter-spacing: -.045em;
  }
  .hero-thesis {
    max-width: 62ch;
    margin: 28px 0 0;
    color: var(--ink-soft);
    font-size: clamp(16px, 1.5vw, 19px);
    line-height: 1.78;
  }
  .signal-strip {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    border-top: 1px solid var(--line-strong);
    border-bottom: 1px solid var(--line-strong);
  }
  .signal-strip > div {
    min-width: 0;
    padding: 22px clamp(14px, 2vw, 28px);
    border-right: 1px solid var(--line);
  }
  .signal-strip > div:first-child { padding-left: 0; }
  .signal-strip > div:last-child { padding-right: 0; border-right: 0; }
  .signal-strip strong {
    display: block;
    color: var(--accent-strong);
    font: 800 clamp(24px, 3vw, 40px)/1 var(--font-data);
    letter-spacing: -.04em;
  }
  .signal-strip span {
    display: block;
    margin-top: 10px;
    color: var(--ink);
    font-weight: 700;
  }
  .signal-strip small {
    display: block;
    margin-top: 5px;
    color: var(--muted);
    font-size: 12px;
    line-height: 1.5;
  }
  .decision-dashboard {
    padding: clamp(42px, 6vw, 86px) var(--content-pad);
    background: var(--paper-alt);
    border-top: 1px solid var(--line);
    border-bottom: 1px solid var(--line-strong);
  }
  .decision-dashboard__head, .chapter-index__head {
    max-width: 72ch;
    margin-bottom: 30px;
  }
  .decision-dashboard__head h2, .chapter-index__head h2 {
    margin: 0;
    font-size: clamp(28px, 3vw, 42px);
    line-height: 1.18;
    letter-spacing: -.025em;
  }
  .decision-dashboard__head p, .chapter-index__head p {
    margin: 12px 0 0;
    color: var(--muted);
  }
  .priority-lanes { border-top: 4px solid var(--ink); }
  .priority-lane {
    display: grid;
    grid-template-columns: 64px minmax(180px, .65fr) minmax(0, 1.35fr);
    gap: clamp(18px, 3vw, 46px);
    padding: 24px 0;
    align-items: start;
    border-bottom: 1px solid var(--line-strong);
  }
  .priority-lane__rank {
    color: var(--accent-strong);
    font: 800 18px/1.4 var(--font-data);
  }
  .priority-lane h3 { margin: 0; font-size: 18px; line-height: 1.45; }
  .priority-lane p { margin: 0; color: var(--ink-soft); }
  .chapter-index {
    padding: clamp(42px, 6vw, 82px) var(--content-pad);
    border-bottom: 1px solid var(--line-strong);
  }
  .chapter-index__grid {
    display: grid;
    grid-template-columns: minmax(0, 1.15fr) minmax(0, .85fr);
    border-top: 3px solid var(--ink);
  }
  .chapter-index__grid a {
    display: grid;
    grid-template-columns: 38px minmax(0, 1fr) auto;
    gap: 14px;
    min-height: 72px;
    padding: 18px 18px 18px 0;
    align-items: center;
    color: var(--ink);
    border-bottom: 1px solid var(--line);
    text-decoration: none;
  }
  .chapter-index__grid a:nth-child(odd) { padding-right: 30px; }
  .chapter-index__grid a:nth-child(even) { padding-left: 30px; border-left: 1px solid var(--line); }
  .chapter-index__grid a:hover { color: var(--accent-strong); background: var(--accent-soft); }
  .chapter-index__no { color: var(--muted); font: 700 13px/1 var(--font-data); }
  .chapter-index__grid b { color: var(--accent); font-size: 18px; }
  .report-body { padding: 8px var(--content-pad) 80px; }
  .report-section {
    position: relative;
    padding: clamp(48px, 7vw, 96px) 0 18px;
    border-top: 1px solid var(--line);
  }
  .report-section:first-child { border-top: 0; }
  .report-section > h2 {
    max-width: 26ch;
    margin: 0 0 28px;
    color: var(--ink);
    font-size: clamp(26px, 3vw, 42px);
    line-height: 1.18;
    letter-spacing: -.025em;
  }
  .report-section[data-section="3"],
  .report-section[data-section="7"],
  .report-section[data-section="10"] {
    margin-inline: calc(var(--content-pad) * -.32);
    padding-inline: calc(var(--content-pad) * .32);
  }
  .report-section h3 { margin: 36px 0 14px; color: var(--ink-soft); font-size: 20px; line-height: 1.4; }
  .report-section h4 { margin: 26px 0 10px; font-size: 17px; }
  .report-section p { max-width: 78ch; margin: 12px 0; }
  .report-section > p:first-of-type {
    color: var(--ink-soft);
    font-size: 17px;
    line-height: 1.8;
  }
  strong { color: var(--ink); }
  .visual-block {
    margin: 10px 0 36px;
    padding: 0;
    border: 0;
  }
  .visual-block > figcaption {
    margin: 0 0 22px;
    color: var(--muted);
    font: 700 13px/1.4 var(--font-display);
  }
  .visual-note { margin: 16px 0 0; color: var(--muted); font-size: 13px; }
  .priority-grid, .method-grid, .mainline-grid {
    display: grid;
    grid-template-columns: minmax(0, 1.18fr) minmax(0, .82fr);
    border-top: 3px solid var(--ink);
  }
  .priority-item, .method-item, .mainline-item {
    display: grid;
    grid-template-columns: 42px minmax(0, 1fr);
    gap: 14px;
    padding: 20px 18px 20px 0;
    border-bottom: 1px solid var(--line);
  }
  .priority-item:nth-child(even), .method-item:nth-child(even), .mainline-item:nth-child(even) {
    padding-left: 24px;
    border-left: 1px solid var(--line);
  }
  .priority-rank, .method-item > span, .mainline-item > span, .audience-order {
    color: var(--accent);
    font: 800 14px/1.5 var(--font-data);
  }
  .priority-item strong, .method-item strong, .mainline-item strong { display: block; font-size: 16px; }
  .priority-item p, .method-item p, .mainline-item p { margin: 6px 0 0; color: var(--muted); font-size: 13px; }
  .source-map {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 28px;
  }
  .source-item { padding: 18px 0 20px; border-top: 3px solid var(--accent); }
  .source-item strong, .source-item span { display: block; }
  .source-item span { margin-top: 7px; color: var(--accent-strong); font-size: 13px; }
  .source-item p { margin: 8px 0 0; color: var(--muted); font-size: 13px; }
  .source-stream { border-top: 3px solid var(--ink); }
  .source-flow {
    display: grid;
    grid-template-columns: 38px minmax(130px, .75fr) minmax(180px, 1fr) minmax(220px, 1.35fr);
    gap: 18px;
    align-items: center;
    padding: 16px 0;
    border-bottom: 1px solid var(--line);
  }
  .source-flow__index {
    color: var(--accent);
    font: 800 14px/1 var(--font-data);
  }
  .source-flow small {
    display: block;
    margin-bottom: 5px;
    color: var(--muted);
    font-size: 10px;
    font-weight: 800;
    letter-spacing: .08em;
  }
  .source-flow strong, .source-flow span { display: block; }
  .source-flow__file {
    position: relative;
    padding: 10px 34px 10px 12px;
    background: var(--paper);
    border-top: 2px solid var(--accent);
    color: var(--ink-soft);
    font-size: 12px;
    overflow-wrap: anywhere;
  }
  .source-flow__file::after {
    content: "→";
    position: absolute;
    top: 50%;
    right: 10px;
    color: var(--accent);
    font: 800 16px/1 var(--font-data);
    transform: translateY(-50%);
  }
  .source-flow__purpose p { margin: 0; color: var(--ink-soft); font-size: 13px; }
  .fact-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 14px;
  }
  .fact-item {
    min-width: 0;
    min-height: 128px;
    padding: 18px;
    background: var(--paper);
    border-top: 3px solid var(--accent);
  }
  .fact-item span, .selling-item span { display: block; color: var(--muted); font-size: 12px; }
  .fact-item strong, .selling-item strong { display: block; margin-top: 9px; font-size: 15px; }
  .selling-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 1px;
    background: var(--line);
  }
  .selling-strategy-visual { display: grid; gap: 28px; }
  .selling-item { min-width: 0; padding: 18px; background: var(--surface); }
  .selling-item p { margin: 8px 0 0; color: var(--muted); font-size: 12px; }
  .selling-item.is-missing { background: var(--warning-soft); }
  .voc-board { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 34px 28px; }
  .voc-group { min-width: 0; border-top: 4px solid var(--ink); }
  .voc-group > header { display: flex; align-items: end; justify-content: space-between; gap: 14px; padding: 16px 0 12px; border-bottom: 1px solid var(--line-strong); }
  .voc-group > header small { display: block; color: var(--accent); font-size: 10px; font-weight: 850; letter-spacing: .1em; }
  .voc-group > header h3 { margin: 3px 0 0; font-size: 18px; }
  .voc-group > header > span { color: var(--muted); font: 700 11px/1.4 var(--font-data); }
  .voc-list { display: grid; }
  .voc-item { display: grid; grid-template-columns: 46px minmax(0, 1fr); gap: 12px; padding: 14px 0; border-bottom: 1px solid var(--line); }
  .voc-rank { color: var(--accent); font: 850 13px/1.4 var(--font-data); }
  .voc-item__main { min-width: 0; }
  .voc-item__main > strong { display: block; color: var(--ink); font-size: 15px; }
  .voc-metrics { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 7px; }
  .voc-metrics span { padding: 3px 8px; border-radius: 999px; background: var(--accent-soft); color: var(--ink-soft); font: 750 11px/1.4 var(--font-data); }
  .voc-item blockquote { margin: 9px 0 0; padding: 0; border: 0; color: var(--ink-soft); font-size: 12px; }
  .voc-source { display: block; margin-top: 6px; color: var(--muted); font-size: 10px; overflow-wrap: anywhere; }
  .voc-details { margin-top: 28px; }
  .voc-raw-detail { padding: 18px 20px 22px; color: var(--ink-soft); font-size: 13px; line-height: 1.85; }
  .keyword-panel {
    margin-bottom: 34px;
    padding: 22px 0 28px;
    border-top: 4px solid var(--ink);
    border-bottom: 1px solid var(--line-strong);
  }
  .keyword-panel > header {
    display: flex;
    gap: 18px;
    align-items: end;
    justify-content: space-between;
    margin-bottom: 20px;
  }
  .keyword-panel > header small {
    display: block;
    margin-bottom: 5px;
    color: var(--accent);
    font-size: 10px;
    font-weight: 850;
    letter-spacing: .1em;
  }
  .keyword-panel > header h3 { margin: 0; font-size: 18px; }
  .keyword-panel > header > span {
    color: var(--muted);
    font: 750 11px/1.5 var(--font-data);
  }
  .word-cloud {
    display: flex;
    min-height: 216px;
    padding: 28px clamp(18px, 4vw, 48px);
    flex-wrap: wrap;
    gap: 14px 22px;
    align-content: center;
    align-items: baseline;
    justify-content: center;
    background:
      linear-gradient(135deg, color-mix(in srgb, var(--accent-soft) 68%, transparent), transparent 52%),
      var(--paper);
  }
  .word-cloud__item {
    display: inline-flex;
    gap: 5px;
    align-items: baseline;
    color: var(--ink-soft);
    line-height: 1;
    white-space: nowrap;
  }
  .word-cloud__item b { font-weight: 800; letter-spacing: -.025em; }
  .word-cloud__item small { color: var(--muted); font: 700 9px/1 var(--font-data); }
  .word-cloud__item.weight-1 b { font-size: 15px; }
  .word-cloud__item.weight-2 b { font-size: 19px; }
  .word-cloud__item.weight-3 b { font-size: 24px; }
  .word-cloud__item.weight-4 b { color: var(--accent); font-size: 31px; }
  .word-cloud__item.weight-5 b { color: var(--accent-strong); font-size: 40px; }
  .facet-grid, .count-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: clamp(28px, 4vw, 56px);
  }
  .profile-board {
    display: grid;
    grid-template-columns: repeat(var(--profile-columns, 1), minmax(0, 1fr));
    gap: 24px;
    align-items: start;
  }
  .profile-platform-index {
    display: flex;
    gap: 18px;
    align-items: center;
    justify-content: space-between;
    margin: 0 0 26px;
    padding: 14px 0;
    border-top: 1px solid var(--line-strong);
    border-bottom: 1px solid var(--line);
  }
  .profile-platform-index strong { font-size: 14px; }
  .profile-platform-index div { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
  .profile-platform-index span {
    padding: 6px 10px;
    color: var(--accent-strong);
    background: var(--paper-soft);
    border: 1px solid var(--line);
    font-size: 12px;
    font-weight: 750;
  }
  .profile-panel {
    min-width: 0;
    padding: 0 18px 22px;
    border: 1px solid var(--line-strong);
    background: var(--surface);
  }
  .profile-panel__head {
    display: grid;
    grid-template-columns: 46px minmax(0, 1fr);
    gap: 12px;
    align-items: baseline;
    padding: 14px 0;
    border-top: 4px solid var(--accent);
  }
  .profile-panel__head span {
    color: var(--accent);
    font: 800 15px/1 var(--font-data);
  }
  .profile-panel__head h3 { margin: 0; font-size: 19px; }
  .profile-kpis {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 1px;
    margin: 4px 0 24px;
    background: var(--line);
  }
  .profile-kpi {
    min-width: 0;
    padding: 14px 16px 16px;
    background: var(--paper);
  }
  .profile-kpi > span, .profile-kpi > small {
    display: block;
    color: var(--muted);
    font-size: 11px;
  }
  .profile-kpi > strong {
    display: block;
    margin: 7px 0 4px;
    color: var(--accent-strong);
    font: 850 clamp(26px, 3vw, 38px)/1 var(--font-data);
    letter-spacing: -.04em;
  }
  .profile-facets {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    gap: 20px 22px;
  }
  .bar-facet, .count-group { min-width: 0; }
  .bar-facet h3, .bar-facet h4, .count-group h3 { margin: 0 0 18px; font-size: 15px; }
  .bar-row { margin: 15px 0; }
  .bar-label { display: flex; gap: 14px; justify-content: space-between; align-items: baseline; }
  .bar-label span { min-width: 0; color: var(--ink-soft); font-size: 13px; }
  .bar-label strong { font: 800 13px/1.3 var(--font-data); white-space: nowrap; }
  .bar-track { height: 7px; margin-top: 8px; background: var(--line); overflow: hidden; }
  .bar-track span { display: block; width: var(--bar-size); height: 100%; background: var(--series-1); }
  .method-playbooks {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(290px, 1fr));
    gap: 24px;
    align-items: start;
  }
  .method-playbook { min-width: 0; padding: 0 18px 18px; border: 1px solid var(--line-strong); background: var(--surface); }
  .method-playbook > header {
    display: grid;
    grid-template-columns: 96px minmax(0, 1fr);
    gap: 14px;
    align-items: center;
    padding: 12px 0;
    border-top: 4px solid var(--ink);
  }
  .method-playbook > header span {
    color: var(--accent);
    font: 800 12px/1 var(--font-data);
    letter-spacing: .06em;
  }
  .method-playbook > header strong { font-size: 16px; }
  .material-card-list { display: grid; gap: 1px; background: var(--line); }
  .material-card { min-width: 0; padding: 16px; background: var(--paper); }
  .material-card > header { display: grid; grid-template-columns: 32px minmax(0, 1fr); gap: 10px; align-items: start; }
  .material-card > header span { color: var(--accent); font: 800 12px/1.4 var(--font-data); }
  .material-card > header strong { font-size: 13px; line-height: 1.55; }
  .material-card > div, .material-card > footer { margin: 12px 0 0 42px; }
  .material-card small { display: block; margin-bottom: 4px; color: var(--muted); font-size: 10px; font-weight: 800; }
  .material-card p { margin: 0; color: var(--ink-soft); font-size: 12px; line-height: 1.65; }
  .module-details { margin-top: 28px; }
  .module-raw-detail { padding: 18px 20px 22px; color: var(--ink-soft); font-size: 13px; line-height: 1.85; }
  .method-flow-list { border-bottom: 1px solid var(--line); }
  .method-flow-row {
    display: grid;
    grid-template-columns: 38px minmax(150px, .75fr) minmax(190px, 1fr) minmax(220px, 1.2fr);
    gap: 18px;
    align-items: start;
    padding: 18px 0;
    border-top: 1px solid var(--line);
  }
  .method-flow-row__index {
    color: var(--accent);
    font: 800 13px/1.4 var(--font-data);
  }
  .method-flow-row > div { position: relative; padding-right: 18px; }
  .method-flow-row > div:not(:last-child)::after {
    content: "→";
    position: absolute;
    top: 14px;
    right: -6px;
    color: var(--accent);
    font: 800 15px/1 var(--font-data);
  }
  .method-flow-row small {
    display: block;
    margin-bottom: 5px;
    color: var(--muted);
    font-size: 10px;
    font-weight: 800;
  }
  .method-flow-row strong { display: block; font-size: 14px; }
  .method-flow-row p { margin: 0; color: var(--ink-soft); font-size: 12px; }
  .ordinal-list { display: grid; gap: 0; border-top: 3px solid var(--ink); }
  .ordinal-item {
    display: grid;
    grid-template-columns: 66px minmax(0, 1fr);
    gap: 22px;
    padding: 20px 0;
    border-bottom: 1px solid var(--line);
  }
  .ordinal-item > span { color: var(--accent); font: 800 20px/1.3 var(--font-data); }
  .ordinal-item strong { font-size: 16px; }
  .ordinal-item p { margin: 5px 0 0; color: var(--muted); font-size: 13px; }
  .audience-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 20px 34px; }
  .audience-item { position: relative; min-height: 184px; padding: 22px 0 22px 46px; border-top: 3px solid var(--accent); }
  .audience-order { position: absolute; top: 23px; left: 0; }
  .audience-item > strong { display: block; min-height: 50px; }
  .audience-item dl { margin: 14px 0 0; }
  .audience-item dl > div { display: grid; grid-template-columns: 42px minmax(0, 1fr); gap: 8px; margin-top: 8px; }
  .audience-item dt { color: var(--muted); font-size: 12px; }
  .audience-item dd { margin: 0; font-size: 13px; }
  .audience-routes { display: grid; gap: 16px; }
  .audience-route {
    display: grid;
    grid-template-columns: minmax(190px, .72fr) minmax(0, 1.55fr);
    gap: 18px 30px;
    padding: 20px 0;
    border-top: 3px solid var(--accent);
  }
  .audience-route > header {
    display: grid;
    grid-template-columns: 38px minmax(0, 1fr);
    gap: 10px;
    align-items: start;
  }
  .audience-route .audience-order { position: static; }
  .audience-route > header strong { font-size: 15px; line-height: 1.6; }
  .audience-route__path {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 28px minmax(0, 1fr);
    gap: 8px;
    align-items: stretch;
  }
  .audience-route__path > div {
    padding: 13px 14px;
    background: var(--paper);
    border-top: 3px solid var(--line-strong);
  }
  .audience-route__path > div:last-child {
    background: var(--accent-soft);
    border-top-color: var(--accent);
  }
  .audience-route__path small {
    display: block;
    color: var(--muted);
    font-size: 10px;
    font-weight: 800;
    letter-spacing: .08em;
  }
  .audience-route__path p { margin: 6px 0 0; font-size: 12px; }
  .route-arrow {
    display: grid;
    place-items: center;
    color: var(--accent);
    font: 850 20px/1 var(--font-data);
  }
  .audience-evidence {
    grid-column: 2;
    margin: -6px 0 0 !important;
    color: var(--muted);
    font-size: 11px !important;
  }
  .audience-evidence span {
    display: inline-block;
    margin-right: 8px;
    padding: 2px 6px;
    color: var(--accent-strong);
    background: var(--accent-soft);
    font-weight: 800;
  }
  .stacked-bar { display: flex; min-height: 62px; overflow: hidden; background: var(--paper-alt); }
  .stacked-bar > span {
    display: flex;
    width: var(--share);
    min-width: 2px;
    align-items: center;
    justify-content: center;
  }
  .stacked-bar b {
    padding: 4px 6px;
    color: var(--ink);
    background: var(--surface);
    border: 1px solid var(--ink);
    font: 800 13px/1 var(--font-data);
  }
  .series-1 { background: var(--series-1); }
  .series-2 { background: var(--series-2); }
  .series-3 { background: var(--series-3); }
  .series-4 { background: var(--series-4); }
  .series-5 { background: var(--series-5); }
  .series-6 { background: var(--series-6); }
  .content-mix-dashboard {
    display: grid;
    grid-template-columns: minmax(270px, .82fr) minmax(0, 1.55fr);
    gap: clamp(28px, 5vw, 72px);
    align-items: center;
  }
  .mix-breakdown { min-width: 0; }
  .mix-breakdown > h3 { margin: 0 0 18px; font-size: 15px; }
  .donut-pair {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: clamp(28px, 5vw, 68px);
  }
  .donut-card { min-width: 0; }
  .donut-card > h3 {
    margin: 0 0 18px;
    color: var(--ink);
    font-size: 15px;
  }
  .donut-card__body {
    display: grid;
    grid-template-columns: minmax(152px, 210px) minmax(0, 1fr);
    gap: 24px;
    align-items: center;
  }
  .donut-card__body.has-no-legend {
    grid-template-columns: minmax(180px, 230px);
    justify-content: center;
  }
  .donut-chart {
    display: grid;
    width: min(100%, 210px);
    aspect-ratio: 1;
    place-items: center;
    background: var(--donut-fill);
    border-radius: 50%;
  }
  .donut-chart__center {
    display: grid;
    width: 58%;
    aspect-ratio: 1;
    place-content: center;
    padding: 10px;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: 50%;
    text-align: center;
  }
  .donut-chart__center strong {
    color: var(--accent-strong);
    font: 850 clamp(24px, 3vw, 38px)/1 var(--font-data);
    letter-spacing: -.045em;
  }
  .donut-chart__center span {
    margin-top: 7px;
    color: var(--muted);
    font-size: 10px;
    font-weight: 800;
  }
  .donut-legend { border-top: 1px solid var(--line-strong); }
  .donut-legend > div {
    display: grid;
    grid-template-columns: 10px minmax(0, 1fr) auto auto;
    gap: 7px;
    align-items: center;
    padding: 9px 0;
    border-bottom: 1px solid var(--line);
  }
  .donut-legend i { width: 9px; height: 9px; border-radius: 50%; }
  .donut-legend span { min-width: 0; color: var(--ink-soft); font-size: 12px; }
  .donut-legend strong { font: 800 12px/1 var(--font-data); white-space: nowrap; }
  .donut-legend small { min-width: 38px; color: var(--muted); font: 700 10px/1 var(--font-data); text-align: right; }
  .stacked-legend {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 12px 28px;
    margin-top: 18px;
  }
  .stacked-legend > div { display: grid; grid-template-columns: 12px minmax(0, 1fr) auto; gap: 8px; align-items: center; }
  .stacked-legend i { width: 10px; height: 10px; }
  .stacked-legend span { color: var(--ink-soft); font-size: 13px; }
  .stacked-legend strong { font: 800 13px/1 var(--font-data); }
  .execution-matrix {
    display: grid;
    grid-template-columns: minmax(92px, .65fr) repeat(3, minmax(92px, 1fr));
    gap: 1px;
    margin-top: 34px;
    background: var(--line);
    border: 1px solid var(--line);
  }
  .execution-matrix__corner,
  .execution-matrix__head,
  .execution-matrix__rowhead,
  .execution-matrix__cell {
    position: relative;
    min-width: 0;
    padding: 13px 14px;
    background: var(--surface);
  }
  .execution-matrix__corner,
  .execution-matrix__head {
    color: var(--muted);
    font-size: 11px;
    font-weight: 800;
  }
  .execution-matrix__rowhead {
    color: var(--accent-strong);
    font: 800 13px/1.5 var(--font-data);
  }
  .execution-matrix__cell { text-align: center; overflow: hidden; }
  .execution-matrix__cell::before {
    content: "";
    position: absolute;
    inset: 0;
    background: var(--accent);
    opacity: calc(.06 + var(--heat) * .34);
  }
  .execution-matrix__cell strong,
  .execution-matrix__cell span { position: relative; z-index: 1; }
  .execution-matrix__cell strong { font: 850 22px/1 var(--font-data); }
  .execution-matrix__cell span { margin-left: 3px; color: var(--muted); font-size: 10px; }
  .action-phase-track {
    position: relative;
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 28px;
    margin-bottom: 18px;
  }
  .action-phase-track::before {
    content: "";
    position: absolute;
    top: 17px;
    right: 8%;
    left: 8%;
    height: 2px;
    background: var(--line-strong);
  }
  .action-phase-track > div {
    position: relative;
    z-index: 1;
    display: grid;
    grid-template-columns: 34px minmax(0, 1fr) auto;
    gap: 9px;
    align-items: center;
  }
  .action-phase-track span {
    display: grid;
    width: 34px;
    height: 34px;
    place-items: center;
    color: var(--surface);
    background: var(--accent);
    border-radius: 50%;
    font: 800 11px/1 var(--font-data);
  }
  .action-phase-track strong { font-size: 13px; }
  .action-phase-track small {
    padding: 2px 6px;
    color: var(--muted);
    background: var(--surface);
    font-size: 10px;
  }
  .action-roadmap {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 0 28px;
    border-top: 4px solid var(--accent);
  }
  .action-roadmap > section { min-width: 0; }
  .action-roadmap h3 {
    margin: 0;
    padding: 18px 0;
    color: var(--accent-strong);
    border-bottom: 1px solid var(--line-strong);
    font-size: 16px;
  }
  .action-item {
    display: grid;
    grid-template-columns: 58px minmax(0, 1fr);
    gap: 18px;
    padding: 20px 0;
    border-bottom: 1px solid var(--line);
  }
  .action-item span { color: var(--accent); font: 800 18px/1.4 var(--font-data); }
  .action-item p { margin: 0; }
  .action-item small {
    display: inline-block;
    margin-top: 7px;
    padding: 3px 7px;
    color: var(--accent-strong);
    background: var(--accent-soft);
    font-size: 11px;
    font-weight: 750;
  }
  .limitation-list { margin: 0; padding: 0; list-style: none; background: var(--warning-soft); }
  .limitation-list li { position: relative; padding: 15px 18px 15px 48px; border-bottom: 1px solid rgb(141 85 49 / .22); }
  .limitation-list li::before {
    content: "!";
    position: absolute;
    left: 18px;
    color: var(--warning);
    font: 800 14px/1.8 var(--font-data);
  }
  .guardrail-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 18px;
  }
  .guardrail-group {
    min-width: 0;
    background: var(--warning-soft);
    border-top: 4px solid var(--warning);
  }
  .guardrail-group header {
    display: grid;
    grid-template-columns: 28px minmax(0, 1fr) auto;
    gap: 8px;
    align-items: center;
    padding: 14px 16px;
    border-bottom: 1px solid rgb(141 85 49 / .22);
  }
  .guardrail-group header span {
    color: var(--warning);
    font: 850 16px/1 var(--font-data);
  }
  .guardrail-group header strong { font-size: 14px; }
  .guardrail-group header small { color: var(--muted); font-size: 10px; }
  .guardrail-group ul { margin: 0; padding: 0; list-style: none; }
  .guardrail-group li {
    position: relative;
    padding: 12px 14px 12px 30px;
    border-bottom: 1px solid rgb(141 85 49 / .16);
    font-size: 12px;
  }
  .guardrail-group li::before {
    content: "•";
    position: absolute;
    left: 15px;
    color: var(--warning);
  }
  .evidence-disclosure {
    margin: 22px 0 30px;
    border: 1px solid var(--line-strong);
    background: var(--surface);
  }
  .evidence-disclosure summary {
    display: flex;
    min-height: 54px;
    padding: 14px 16px;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    cursor: pointer;
    color: var(--ink);
    font-weight: 750;
  }
  .evidence-disclosure summary::marker { color: var(--accent); }
  .evidence-disclosure summary small { color: var(--muted); font-size: 12px; font-weight: 500; }
  .evidence-disclosure[open] summary { border-bottom: 1px solid var(--line); background: var(--accent-soft); }
  .evidence-disclosure .table-wrap { margin: 0; padding: 10px 14px 16px; }
  .table-wrap { max-width: 100%; margin: 20px 0 30px; overflow: visible; }
  .table-wrap.compact-table table { width: max-content; min-width: min(620px, 100%); max-width: 100%; }
  .table-wrap.wide-table table { table-layout: fixed; font-size: 12px; }
  .table-wrap.wide-table th, .table-wrap.wide-table td { padding: 8px; }
  table { width: 100%; border-collapse: collapse; table-layout: auto; overflow-wrap: anywhere; font-size: 14px; }
  th, td { padding: 12px; border-bottom: 1px solid var(--line); vertical-align: top; text-align: left; }
  th { color: var(--ink); background: var(--paper-alt); font-weight: 750; }
  tbody tr:nth-child(even) td { background: color-mix(in srgb, var(--paper) 58%, transparent); }
  blockquote { margin: 20px 0; padding: 15px 18px; border-left: 4px solid var(--warning); background: var(--warning-soft); color: var(--ink-soft); }
  code { padding: 2px 5px; background: var(--paper-alt); font-family: var(--font-data); font-size: .92em; }
  pre { max-width: 100%; overflow: auto; padding: 16px; background: var(--ink); color: var(--surface); }
  hr { margin: 32px 0; border: 0; border-top: 1px solid var(--line); }
  ul, ol { padding-left: 24px; }
  img { display: block; max-width: 100%; height: auto; }
  @media (min-width: 769px) {
    .chapter-index { display: none; }
  }
  @media (max-width: 1080px) {
    .shell { grid-template-columns: 190px minmax(0, 1fr); width: min(100% - 28px, 1120px); gap: 16px; margin-top: 14px; }
    .story-stat-hero__grid { grid-template-columns: minmax(220px, .75fr) minmax(0, 1.25fr); gap: 34px; }
    .hero-figure strong { font-size: clamp(54px, 8vw, 88px); }
    .fact-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .source-map { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .source-flow { grid-template-columns: 34px minmax(120px, .7fr) minmax(160px, .9fr) minmax(180px, 1.2fr); gap: 12px; }
    .profile-facets { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .method-flow-row { grid-template-columns: 32px minmax(130px, .7fr) minmax(160px, .9fr) minmax(190px, 1.1fr); gap: 12px; }
    .donut-card__body { grid-template-columns: minmax(136px, 176px) minmax(0, 1fr); gap: 18px; }
  }
  @media (min-width: 769px) and (max-width: 1080px) {
    .table-wrap.wide-table table { display: block; width: 100%; min-width: 0; max-width: none; }
    .table-wrap.wide-table thead {
      position: absolute;
      width: 1px;
      height: 1px;
      margin: -1px;
      padding: 0;
      overflow: hidden;
      clip: rect(0 0 0 0);
      white-space: nowrap;
      border: 0;
    }
    .table-wrap.wide-table tbody,
    .table-wrap.wide-table tr,
    .table-wrap.wide-table td { display: block; width: 100%; }
    .table-wrap.wide-table tr { margin: 0 0 14px; padding: 8px 14px; background: var(--paper); border-left: 3px solid var(--accent); }
    .table-wrap.wide-table td {
      display: grid;
      grid-template-columns: minmax(110px, .7fr) minmax(0, 1.5fr);
      gap: 12px;
      padding: 9px 0;
      background: transparent !important;
      border-bottom: 1px solid var(--line);
    }
    .table-wrap.wide-table td:last-child { border-bottom: 0; }
    .table-wrap.wide-table td::before { content: attr(data-label); color: var(--muted); font-size: 12px; font-weight: 750; }
  }
  @media (max-width: 768px) {
    html { scroll-behavior: auto; }
    .shell { display: block; width: min(100% - 20px, 760px); margin: 10px auto 24px; }
    .toc { display: none; }
    .story-stat-hero { min-height: 0; padding: 28px 22px 34px; }
    .story-stat-hero__meta { display: grid; gap: 4px; }
    .story-stat-hero__grid { grid-template-columns: minmax(0, 1fr); gap: 34px; min-height: 0; padding: 44px 0; }
    .hero-figure { order: 2; }
    .hero-copy { order: 1; }
    .hero-copy h1 { max-width: none; font-size: clamp(32px, 10vw, 48px); }
    .hero-thesis { font-size: 16px; }
    .signal-strip { grid-template-columns: minmax(0, 1fr); }
    .signal-strip > div { padding: 17px 0; border-right: 0; border-bottom: 1px solid var(--line); }
    .signal-strip > div:last-child { border-bottom: 0; }
    .profile-platform-index { display: grid; justify-content: stretch; }
    .profile-platform-index div { justify-content: flex-start; }
    .decision-dashboard, .chapter-index { padding: 42px 22px; }
    .priority-lane { grid-template-columns: 46px minmax(0, 1fr); gap: 14px; }
    .priority-lane p { grid-column: 2; }
    .chapter-index__grid { grid-template-columns: minmax(0, 1fr); }
    .chapter-index__grid a:nth-child(odd), .chapter-index__grid a:nth-child(even) { padding: 16px 0; border-left: 0; }
    .report-body { padding: 0 18px 42px; }
    .report-section { padding-top: 54px; }
    .report-section[data-section="3"], .report-section[data-section="7"], .report-section[data-section="10"] {
      margin-inline: 0;
      padding-inline: 0;
    }
    .priority-grid, .method-grid, .mainline-grid, .audience-grid, .source-map, .facet-grid, .count-grid, .profile-facets, .guardrail-grid {
      grid-template-columns: minmax(0, 1fr);
    }
    .profile-board, .method-playbooks { grid-template-columns: minmax(0, 1fr); }
    .content-mix-dashboard, .donut-pair { grid-template-columns: minmax(0, 1fr); }
    .content-mix-dashboard { gap: 38px; }
    .donut-pair { gap: 42px; }
    .donut-card__body { grid-template-columns: minmax(160px, 210px) minmax(0, 1fr); }
    .keyword-panel > header { align-items: start; flex-direction: column; gap: 7px; }
    .voc-board { grid-template-columns: minmax(0, 1fr); gap: 28px; }
    .voc-item { grid-template-columns: 40px minmax(0, 1fr); }
    .source-flow {
      grid-template-columns: 34px minmax(0, 1fr);
      gap: 8px 12px;
      align-items: start;
    }
    .source-flow__type, .source-flow__file, .source-flow__purpose { grid-column: 2; }
    .source-flow__file::after { content: "↓"; }
    .profile-kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .method-flow-row {
      grid-template-columns: 32px minmax(0, 1fr);
      gap: 8px 12px;
    }
    .method-flow-row > div { grid-column: 2; padding: 10px 12px; background: var(--paper); }
    .method-flow-row > div:not(:last-child)::after {
      content: "↓";
      top: auto;
      right: 12px;
      bottom: -8px;
    }
    .audience-route { grid-template-columns: minmax(0, 1fr); gap: 14px; }
    .audience-route__path, .audience-evidence { grid-column: 1; }
    .action-roadmap { grid-template-columns: minmax(0, 1fr); gap: 24px; }
    .action-phase-track { grid-template-columns: minmax(0, 1fr); gap: 12px; }
    .action-phase-track::before {
      top: 8px;
      bottom: 8px;
      left: 16px;
      width: 2px;
      height: auto;
    }
    .priority-item:nth-child(even), .method-item:nth-child(even), .mainline-item:nth-child(even) {
      padding-left: 0;
      border-left: 0;
    }
    .fact-grid, .selling-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .stacked-legend { grid-template-columns: minmax(0, 1fr); }
    .table-wrap, .table-wrap.compact-table { margin: 18px 0 28px; }
    .table-wrap table, .table-wrap.compact-table table { display: block; width: 100%; min-width: 0; max-width: none; }
    .table-wrap thead {
      position: absolute;
      width: 1px;
      height: 1px;
      margin: -1px;
      padding: 0;
      overflow: hidden;
      clip: rect(0 0 0 0);
      white-space: nowrap;
      border: 0;
    }
    .table-wrap tbody, .table-wrap tr, .table-wrap td { display: block; width: 100%; }
    .table-wrap tr { margin: 0 0 14px; padding: 8px 14px; background: var(--paper); border-left: 3px solid var(--accent); }
    .table-wrap td {
      display: grid;
      grid-template-columns: minmax(84px, .7fr) minmax(0, 1.5fr);
      gap: 12px;
      padding: 9px 0;
      background: transparent !important;
      border-bottom: 1px solid var(--line);
    }
    .table-wrap td:last-child { border-bottom: 0; }
    .table-wrap td::before { content: attr(data-label); color: var(--muted); font-size: 12px; font-weight: 750; }
  }
  @media (max-width: 414px) {
    body { font-size: 15px; }
    .shell { width: min(100% - 12px, 414px); margin-top: 6px; }
    .story-stat-hero { padding: 24px 18px 30px; }
    .hero-figure strong { font-size: clamp(48px, 17vw, 72px); }
    .decision-dashboard, .chapter-index { padding: 38px 18px; }
    .report-body { padding: 0 14px 34px; }
    .fact-grid, .selling-grid { grid-template-columns: minmax(0, 1fr); }
    .profile-kpis { grid-template-columns: minmax(0, 1fr); }
    .donut-card__body { grid-template-columns: minmax(0, 1fr); justify-items: center; }
    .donut-legend { width: 100%; }
    .word-cloud { min-height: 190px; padding: 24px 12px; gap: 12px 16px; }
    .word-cloud__item.weight-4 b { font-size: 27px; }
    .word-cloud__item.weight-5 b { font-size: 34px; }
    .audience-route__path { grid-template-columns: minmax(0, 1fr); }
    .route-arrow { transform: rotate(90deg); }
    .execution-matrix { grid-template-columns: minmax(58px, .72fr) repeat(3, minmax(0, 1fr)); }
    .execution-matrix__corner, .execution-matrix__head, .execution-matrix__rowhead, .execution-matrix__cell {
      padding: 10px 5px;
    }
    .execution-matrix__head, .execution-matrix__corner { font-size: 9px; }
    .priority-lane { grid-template-columns: 40px minmax(0, 1fr); }
    .table-wrap td { grid-template-columns: minmax(72px, .62fr) minmax(0, 1.38fr); gap: 9px; }
    .evidence-disclosure summary { align-items: flex-start; flex-direction: column; gap: 2px; }
  }
  .print-table-copy { display: none; }
  @media (prefers-reduced-motion: reduce) {
    html { scroll-behavior: auto; }
  }
  @media print {
    @page { size: A4 portrait; margin: 12mm; }
    @page wide { size: A4 landscape; margin: 10mm; }
    body {
      background: var(--print-paper);
      font-size: 10.5pt;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    .shell { display: block; width: auto; margin: 0; }
    .toc, .mobile-toc, .skip-link, .chapter-index { display: none !important; }
    .report { box-shadow: none; }
    .story-stat-hero { min-height: 0; padding: 20px 0 26px; border-top-width: 5px; background: var(--print-paper); break-after: page; }
    .story-stat-hero__grid { min-height: 0; }
    .decision-dashboard { padding: 24px 0; background: var(--print-paper); break-after: page; }
    .report-body { padding: 0; }
    .report-section { break-before: page; padding-top: 20px; }
    .visual-block { break-inside: avoid; }
    .keyword-panel, .donut-card, .content-mix-dashboard { break-inside: avoid; }
    .evidence-disclosure { display: none !important; }
    .evidence-disclosure.voc-details { display: block !important; border: 0; }
    .evidence-disclosure.voc-details > summary { display: none !important; }
    .voc-raw-detail { padding: 12px 0 0; }
    .evidence-disclosure.module-details { display: block !important; border: 0; }
    .evidence-disclosure.module-details > summary { display: none !important; }
    .module-raw-detail { padding: 12px 0 0; }
    .print-table-copy { display: block !important; }
    .table-wrap { break-inside: auto; }
    .table-wrap.wide-table { page: wide; }
    .table-wrap.wide-table table { table-layout: fixed !important; font-size: 8.5pt !important; }
    .table-wrap.wide-table th, .table-wrap.wide-table td { padding: 4px 5px !important; }
    .stacked-bar b { color: #111; background: #fff; border: 1px solid #111; }
    table { display: table !important; width: 100% !important; }
    thead { display: table-header-group !important; position: static !important; width: auto !important; height: auto !important; clip: auto !important; }
    tbody { display: table-row-group !important; }
    tr { display: table-row !important; margin: 0 !important; padding: 0 !important; border: 0 !important; background: transparent !important; break-inside: avoid; }
    th, td { display: table-cell !important; width: auto !important; padding: 6px 7px !important; }
    td::before { display: none !important; }
    a { color: var(--ink); text-decoration: none; }
  }`
}
