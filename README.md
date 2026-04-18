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

## linkedin enrichment

linkedin enrichment requires a browser-use profile with linkedin authentication. the cli guides you through setup.

### first-time setup

when you enable linkedin enrichment for the first time, you'll need to sync your linkedin cookies:

1. log into linkedin in a local chromium-based browser (chrome, edge, etc.)

2. schoolyank will show you the sync command:
   ```bash
   curl -fsSL https://browser-use.com/profile.sh | sh
   ```

3. run it in a separate terminal - the script will prompt for your browser-use API key

4. paste your API key (schoolyank shows it for you)

5. select the browser profile where you're logged into linkedin

6. return to schoolyank and confirm the sync is complete

7. select your newly synced profile from the list

### after first setup

once you've synced a profile, schoolyank remembers it:

```
◆ schoolyank

│ school website url: https://example.edu
│ enable linkedin enrichment? yes
│
◇ use saved linkedin profile (linkedin-profile)? yes
│
◇ starting scrape...
```

to use a different profile or re-sync, select "sync new profile" when prompted.

profiles are cached in `profiles/config.json`.

### how it works

- the sync script opens your local browser where you control the login
- cookies are uploaded to browser-use's cloud and stored in a profile
- the agent uses your linkedin session to search for teacher profiles
- one profile can be reused across multiple runs

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
