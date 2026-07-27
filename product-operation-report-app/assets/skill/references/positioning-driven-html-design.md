# Positioning-Driven HTML Design

Read this reference only when the report output is HTML or the user requests design or visualization.

## Core Contract

The report is a decision product for the user's own product. Its visual system must express the report's source-backed product positioning while keeping evidence easy to verify. Do not give every product the same editorial theme, dashboard, palette, or component sequence.

Visual positioning is not a category-colour lookup. It is a translation of product role, audience, buying scene, value signal, and trust model into information hierarchy and visual language.

Keep the generator shell and the exported report separate. The tool UI may explain workflow and interaction structure, but it is not brand evidence for the product being analyzed. Do not copy its admin-dashboard palette, cards, controls, navigation, or preview chrome into the report unless the user explicitly requests that relationship.

If the user explicitly names a general frontend design skill, use that skill to shape the report shell, hierarchy, typography, spacing, chart treatment, and responsive composition. This does not authorize deleting evidence tables, rewriting source-bound copy, merging incompatible metrics, or generating unverified product photography. Product-report source and validation rules remain authoritative.

## 1. Derive the Product Visual Brief

Complete this brief from the report evidence before choosing a design direction. Use `需补充` for unsupported fields.

| Field | Question |
|---|---|
| Product role | What job does the product do in the buyer's life or work? |
| Core promise | What is the strongest source-backed reason to buy? |
| Audience reading style | Does the main audience need direct, reassuring, technical, aspirational, or playful communication? |
| Dominant buying scene | Where and when does the decision happen? |
| Value signal | Is the offer driven by practicality, price, premium experience, expertise, efficiency, identity, or gifting? |
| Trust model | What closes the decision: visible use, ingredients, tests, authority, reviews, craft, service, or ROI? |
| Decision tempo | Is this a quick low-risk purchase, a considered comparison, or a high-stakes procurement decision? |
| Brand evidence | Which official colours, typography, packaging, photography, or brand rules were supplied? |
| Visual prohibitions | Which impressions would misrepresent the product or overstate the evidence? |

Add the completed brief near the top of the HTML as a non-visible comment so later revisions can explain the design choice:

```html
<!-- Product visual brief
role: ...
audience: ...
scene: ...
value-signal: ...
trust-model: ...
design-direction: ...
evidence-confidence: confirmed | partial | insufficient
-->
```

## 2. Select a Direction from Positioning Signals

Use these routes as defaults, not stereotypes. Mixed positioning may combine one primary route with one secondary influence.

| Positioning signal | Default direction | Emphasize | Avoid |
|---|---|---|---|
| Household staple / frequent practical use | Warm editorial field guide; approachable type; moderate density; human-scale charts | Scenes, convenience, repeat use, price/spec clarity | Luxury theatre, excessive whitespace, unsupported health halo |
| Premium / gifting / status | Restrained catalogue; generous whitespace; refined display type; controlled accent | Craft, provenance, experience, proof of quality | Busy dashboard density, fake scarcity, decorative gold everywhere |
| Professional / technical product | Modern technical report; cool neutrals; sans + data face; precise grids | Mechanism, comparison, performance, standards | Lifestyle imagery without evidence, vague emotional claims |
| Wellness / safety-conscious purchase | Calm evidence-led system; clean hierarchy; soft but credible colour | Ingredients, test evidence, usage boundaries, reassurance | Medical appearance or efficacy claims without proof |
| Young / novelty / social product | Energetic hierarchy; stronger accent; faster rhythm; concise labels | Social proof, novelty, use moments, shareability | Childish decoration that weakens trust, invented trend signals |
| B2B / industrial / procurement | Utilitarian decision brief; compact density; strong tables and comparisons | ROI, reliability, implementation, risk, service | Consumer lifestyle framing, ornamental illustration |
| Cultural / local craft product | Material-led editorial narrative; tactile but restrained texture; provenance structure | Origin, craft, people, ritual, authenticity | Fake heritage, generic antique styling, unverified history |

Do not infer gendered colours from audience gender. Do not infer green or medical blue merely because the product relates to food, health, or safety.

## 3. Translate the Direction into the Report

Adapt at least three of these axes. A palette-only change is not a positioning-led design.

1. **Macrostructure** — stat-led, long document, catalogue, technical workbench, field guide, or another structure that fits the decision process.
2. **Information density** — compact for comparison-heavy expert decisions; more breathing room for premium or emotionally led decisions.
3. **Typography** — choose display and body roles that match directness, refinement, technicality, or warmth while preserving Chinese readability.
4. **Palette** — derive paper, ink, and one main accent from supplied brand evidence or the positioning. Keep data series distinguishable and accessible.
5. **Shape and rule language** — choose borders, dividers, radii, and marks that reinforce the product's character without becoming decoration.
6. **Visualization emphasis** — prioritize the relationships that answer this product's main business question, not the same chart set for every report.
7. **Imagery treatment** — use supplied product/packaging/use-scene assets when they materially support the positioning. Never invent product photography or proof.
8. **Copy rhythm** — direct and practical, refined and sparse, technical and exact, or energetic and short according to the audience's reading style.

The first screen must still lead with one business thesis and 2-4 real metrics. Product character changes the expression, not the evidence standard.

## 3.1 Use Familiar Chart Grammar

Default to chart forms that a business reader recognizes immediately. Select the module from the analytical question, not from visual novelty:

- Use horizontal or vertical bars for category, platform, region, age, or other shared-scale comparisons. Start quantitative bars at zero and label important values directly.
- Use grouped bars only when the same categories and units are available for 2-3 comparable series.
- Use a donut, pie, or 100% stacked bar only when the values are explicit parts of one whole and sum to 100%. Keep the category count small enough to label clearly.
- Use a word cloud only when terms can be counted in a defined source sample. State the sample scope and show or expose the counts. Render it as a spatially packed field with high-frequency words larger and near the visual center; a flex-wrapped or left-to-right row of differently sized words is not a word cloud. If no defensible frequency exists, use a keyword list or theme map instead.
- Use an ordered list, phase strip, or roadmap for ranks and sequences. Do not turn ordinal positions into bar lengths, pie slices, or implied percentages.

Give each metric one primary visual. Do not repeat the same percentages as both donuts and bars unless the second view answers a materially different question. Prefer one recognizable chart followed by the unchanged evidence table.

For exported self-contained HTML, verify every chart renders inside the target preview as chart content rather than an attachment or module placeholder. If the preview collapses inline SVG, use native HTML/CSS positioning for a static word cloud or another compatible chart implementation; do not ship a tile that only says “词云”.

## 4. Priority and Fallback Rules

Use this priority order:

1. supplied official brand guidelines and assets
2. source-backed positioning conclusions in the report
3. supported category and audience conventions
4. neutral evidence-first report system

The current generator UI does not enter this priority list unless the user explicitly identifies it as an approved brand system for exported reports.

When evidence is insufficient, do not guess a strong theme. Use the neutral fallback, add `evidence-confidence: insufficient` to the visual brief, and state which brand or positioning input would improve the design.

## 5. Positioning-Fit Validation

Before handoff, verify all of the following:

- A reviewer can explain the visual direction using facts already present in the report.
- The first view communicates who the product is for, the main buying scene, and the strongest reason to buy.
- The style differs from the previous product on at least three meaningful axes when their positioning differs.
- No palette, icon, photo, texture, or typography choice implies an unsupported claim.
- The exported report does not look like a screenshot or extension of the generator's admin interface unless that was explicitly requested.
- Charts preserve source definitions, denominators, order, and uncertainty.
- Original evidence tables and source-bound prose remain intact below the visual layer.
- Desktop and narrow-screen layouts are both readable, with no forced title wrapping or empty table tails.

## Routing Checks

- A fermented vegetable positioned as an everyday family fast-meal solution should read like a warm, practical household field guide: scene-first, direct, trustworthy, and food-real. It should not look like a supplement or a luxury gift.
- A premium skincare gift set should use a restrained catalogue and proof modules with more whitespace; do not default to pink or invent clinical authority.
- An industrial sensor report should use a compact technical workbench with comparison and reliability evidence; do not reuse a lifestyle-editorial food layout.
- If the report has only a product name and no positioning evidence, use the neutral fallback and request or mark the missing positioning inputs.
