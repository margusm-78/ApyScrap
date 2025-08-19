# Coldwell Banker JAX Agents → Brevo CSV (Apify Actor)
This Apify Actor crawls **ColdwellBanker.com** Jacksonville agent directory, opens each agent's profile, follows their **website/social links**, extracts emails, and outputs a **Brevo-ready CSV**.

## What you get
- **BREVO** dataset — columns: `EMAIL, FIRSTNAME, LASTNAME, COMPANY, PHONE, LISTS` (ready to import to Brevo)
- **AUDIT** dataset — QA data: `profile_url, name, phone, company, website, emails_found, chosen_email`

## One‑click run (on Apify)
1. Create a new **Actor** in Apify → **Upload** this ZIP.
2. Build with default settings.
3. Click **Run**. Use defaults or adjust input:
   - `startUrl`: https://www.coldwellbanker.com/city/fl/jacksonville/agents
   - `maxPages`: how many directory pages to paginate (default 50)
   - `maxProfiles`: maximum profiles to process (default 2000)
   - `concurrency`: concurrent browsers (default 5)
   - `perDomainDelayMs`: politeness delay between offsite requests (default 1000ms)
   - `followOffsiteMax`: investigate up to N website/social links per agent (default 5)
   - `preferDomain`: if multiple emails found, prefer this domain (default `@cbvfl.com`)
   - `listTag`: Brevo List tag (default `Coldwell Banker JAX Agents`)

## Export the CSV
After the run completes:
- Open the **BREVO** dataset → **Export** → **CSV**.
- Import into Brevo: Contacts → Import → upload the CSV.

## Notes
- The actor prefers brokerage-domain emails (e.g., `@cbvfl.com`) when multiple are found.
- Offsite pages are fetched with `got-scraping`; emails are extracted with a regex and deduped.
- Be respectful of target sites. Increase `perDomainDelayMs` or lower `concurrency` if needed.
