# schoolyank

extract science, math, and stem teacher data from any school website.

given a school url → outputs a csv with names, emails, mailing addresses, roles, and enriched details for every stem teacher.

## how it works

1. **browser-use** ai agent crawls the school website, finds the staff directory, and extracts stem teacher data
2. **nces database** (us dept of education) verifies the school's mailing address
3. **linkedin** (optional) enriches teacher profiles with full titles and profile urls
4. **validation pipeline** cleans, deduplicates, infers missing emails, and scores confidence

## setup

```bash
bun install
```

set your api key in `.env`:

```
BROWSER_USE_API_KEY=bu_your_key_here
AI_BASE_URL=http://localhost:20128/v1
AI_MODEL=kr/claude-sonnet-4.5
```

## usage

```bash
bun index.ts
```

interactive cli will prompt for:
- school website url
- linkedin enrichment (optional)

output csv lands in `./output/`.

## csv columns

| column | description |
|--------|-------------|
| first_name | teacher's first name |
| last_name | teacher's last name |
| email | email address (verified or inferred) |
| role | teaching role / title |
| department | department (science, math, etc.) |
| school_name | official school name |
| school_address | mailing address (nces-verified when possible) |
| school_city | city |
| school_state | state |
| school_zip | zip code |
| school_phone | school phone number |
| school_district | district name |
| linkedin_url | linkedin profile url (if enriched) |
| data_sources | where each data point came from |
| confidence_score | 1-5 data quality score |

## architecture

see [DESIGN.md](./DESIGN.md) for the full design document.

```
index.ts              → cli (clack/prompts)
src/orchestrator.ts   → coordinates the 4-phase pipeline
src/scraper.ts        → browser-use school website extraction
src/nces.ts           → federal school database lookup
src/linkedin.ts       → optional linkedin enrichment
src/validator.ts      → data quality pipeline
src/csv.ts            → csv export
src/ai.ts             → openai-compatible llm client
src/browser.ts        → browser-use session management
src/types.ts          → shared types
src/utils.ts          → helpers
```
