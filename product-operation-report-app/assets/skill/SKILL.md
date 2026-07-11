---
name: product-operation-report
description: Use when the user asks to create, update, or run a 产品经营报告/产品定义报告/产品定音报告 for a product using first-party data, competitor data, product selling points, audience portraits, own/competitor explosive materials, and Video Account content strategy. The workflow outputs a source-bound report with audience structure, selling-point ranking, content mainlines, 3.1/3.2/3.99 execution topics, and optional Feishu cloud doc creation.
metadata:
  short-description: 生成产品经营报告
---

# 产品经营报告

## Goal

Create a source-bound product operation report that turns scattered product, platform, competitor, and material data into:

1. product positioning and business judgment
2. core buying audience portrait
3. user-view selling-point ranking
4. audience x pain point x scene x selling point content matrix
5. Video Account content mainlines
6. executable topic/script table

If the user asks for a Feishu document, create or update the cloud doc after the report is generated.

## Inputs To Collect

Ask only when required. Otherwise use what the user supplied.

- Product basics: product name/category, SKU/spec/price, current positioning, known usage scenes, known selling points.
- First-party data: Douyin/抖店罗盘, 巨量云图, 视频号, product reviews, live-room reviews, refunds/negative feedback, own explosive material table.
- Competitor data: known competitors or candidate competitors, competitor SKU/spec/price, audience portrait, sales clues, explosive material table, mechanism/play style.
- Material data: own and competitor records with title, 3-second opening, script/copy, content type, perspective, metrics, links, attachments if available.
- Output target: local markdown, Feishu doc/wiki/base, or both.

## Source Rules

- Do not invent product facts, prices, certifications, activity mechanisms, backing claims, video links, or 3-second openings.
- If a source field is missing, write `需补充` or explain the limitation.
- 3-second openings must come from supplied own/competitor materials. They may be lightly normalized only when the original meaning is preserved.
- Treat platform audience differences as signal, not conflict. Normalize every data source into `Who / Context / Why`.
- Decide final audiences by demand distance and business priority, not only by the largest percentage on one platform.
- For food/health/safety claims, keep wording conservative unless the source explicitly proves the claim.

## Workflow

### 1. Confirm Product

Output a compact product basics table:

| Field | Content |
|---|---|
| Product name/category |  |
| Main SKU/spec/price |  |
| Current positioning |  |
| Known usage scenes |  |
| Known selling points |  |

### 2. Extract Data

Read all provided files/links/tables/screenshots before analysis.

For each source, extract only visible or readable facts:

| Source type | Required extraction |
|---|---|
| Video Account screenshot | gender, age, region, audience attribute, consumption range, purchase preference |
| Cloud Chart / audience CSV | gender, age, region, consumption group, life stage, category preference |
| Shop compass / product XLSX | main SKU, GMV, orders, buyers, AOV, spend/ROI when available |
| Own material table | count, 3.1/3.2/3.99 distribution, perspective, content form, top openings, high-performing structures |
| Competitor material table | benchmark brand/product, content type, perspective, pain-point openings, trust tactics, reusable structures |
| Reviews/refunds | explicit praise, objections, trust blockers, usage blockers |

When data sources disagree, keep both and explain the platform meaning.

### 3. Lock Competitor Logic

If competitors are already provided, use them directly.

If not, recommend candidate competitor directions using these eight dimensions:

1. direct competitor
2. same category competitor
3. cross-category substitute
4. same selling point
5. same pain point
6. same scene
7. same audience
8. same emotion or solution

Then state what data should be collected from each competitor: product/SKU/price, audience, explosive material, mechanism, and trust proof.

### 4. Decompose Selling Points

Use the 12 selling-point categories as a checklist, but always translate them into user-view buying reasons:

1. packaging
2. price
3. process/craft
4. material/ingredient
5. functionality
6. scene
7. place/origin
8. audience
9. usage method
10. endorsement/proof
11. emotion/story
12. scarcity/mechanism

Then rank the product's selling points by conversion value:

| Rank | User-view selling point | Product fact | Audience/scene | Role |
|---|---|---|---|---|
| 1 |  |  |  | conversion hook |
| 2 |  |  |  | trust support |
| 3 |  |  |  | use certainty |
| 4 |  |  |  | repeat purchase |
| 5 |  |  |  | conversion close |

### 5. Build Core Audience Portrait

Prefer four rows for Video Account-focused operation:

| Priority | Audience | Data evidence/features | Core selling point | Core scene | Content language |
|---|---|---|---|---|---|
| 第一主力人群 |  |  |  |  |  |
| 第二承接人群 |  |  |  |  |  |
| 视频号核心人群 |  |  |  |  |  |
| 增量拓展人群 |  |  |  |  |  |

The portrait must answer:

- Who is buying?
- In what scene do they buy/use?
- Why are they moved?
- Why buy now?
- Why might they not buy?

### 6. Create Video Account Content Mainlines

Derive mainlines from:

`ranked selling points x core audience x usage scene x own/competitor material evidence`

Use this table:

| Content mainline | Data/evidence basis | Audience | Selling point | Scene | Content expression | Role |
|---|---|---|---|---|---|---|

In this table, the `Audience` column must write the detailed audience description, such as `31-45 岁已育女性/家庭主理人` or `50+/60+ 都市银发和小镇中老年家庭用户`. Do not write only internal priority labels such as `第一主力`, `第二承接`, `视频号核心`, or `增量拓展`.

Also recommend content ratio when useful, but do not overstate precision.

### 7. Create Execution Strategy

Use only three perspectives unless the user changes the rule:

- 商家视角: trust, source, factory, brand, supply chain, quality control, after-sales, competitor comparison.
- 用户视角: real experience, family scene, repurchase, eating/using feedback, daily life.
- 专业视角: expert, test, data, ingredient table, certification, process, standard, principle, visual proof.

Execution table:

| Script ID | Content mainline | Topic | Class | Perspective | Audience | Scene | Opening type | 3-second opening source | Reference structure | Priority | Status | Reference link |
|---|---|---|---|---|---|---|---|---|---|---|---|---|

In this execution table, the `Audience` column must also use detailed audience descriptions instead of priority labels. The table should be readable by达人、编导、剪辑 without needing to look back at the audience portrait table.

Class must be one of:

- `3.1`: audience/scenario seeding
- `3.2`: trust, comparison, test, proof, objection handling
- `3.99`: price/mechanism/conversion close

### 8. Write Final Report

Default report sections:

1. 结论先行
2. 数据来源与使用范围
3. 产品基础信息
4. 一方数据核心判断
5. 竞品与素材打法判断
6. 产品全量卖点拆解
7. 卖点用户视角排序
8. 核心成交人群画像与卖点场景匹配
9. 视频号内容主线设计
10. 内容执行方向
11. 经营建议
12. 本次报告限制

Keep the report readable for business users. Prefer tables for structured judgments and short paragraphs for conclusions.

### 9. Feishu Output

If the user asks to create a Feishu cloud doc:

- Use the user's requested CLI/profile/folder when specified.
- Create the doc in the target folder if a folder token is provided or can be found.
- If user authorization is missing, generate a fresh device-flow QR/link and wait for the user to confirm completion before polling the device code.
- After creation/update, fetch the doc back to verify the title/body.
- Return the Feishu URL.

### 10. Cleanup

After the report is created and verified:

- Delete temporary scripts, JSON exports, QR codes, screenshots, downloaded working copies, and other disposable files generated during the run.
- Keep final deliverables, durable skill files, and explicitly requested local source reports.

## Optional SOP

For a fuller explanation of the method and teaching-friendly SOP, read `SOP.md`. The `SKILL.md` above is sufficient to run the task.
