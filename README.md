# LIV Dashboard

Internal event analytics dashboard for **LIV Las Vegas** (nightclub) and **LIV Beach** (dayclub) at Fontainebleau Las Vegas.

Built as a single-file React JSX component — drop into any React app or run via Claude Artifacts.

## Features

- **TIXR** — ticket sales, revenue, pace, ticket type breakdown (Male GA / Female GA / Expedited / VIP Backstage)
- **Speakeasy** — secondary ticketing channel, merges with TIXR by event
- **UrVenue** — VIP table reservations, section-level fill rates, min-spend tracking
- **Meta Ads** — campaign performance per event (Spend, ROAS, CPM, Purchases, Cost/Purchase)
- Male/Female ratio bar per event (from ticket type data)
- % Sold badge with color-coded thresholds
- Past Events tab (events auto-drop after end of day)
- Inline goal editing per event
- 30-day ticket pace chart and table booking activity chart

## Credentials

API credentials are entered via the **⚙ config** panel in the UI — nothing is stored in source.

Platforms require:
| Platform | LIV Las Vegas | LIV Beach |
|---|---|---|
| TIXR | Public Key + Private Key + Group ID (1841) | Public Key + Private Key + Group ID (1927) |
| Speakeasy | API Key + Venue ID | API Key + Venue ID |
| UrVenue | API Key + Venue ID | API Key + Venue ID |
| Meta Ads | Access Token + Ad Account ID | Access Token + Ad Account ID |

TIXR uses HMAC-SHA256 authentication (Public Key + Timestamp signed with Private Key).

## Campaign Matching (Meta)

Campaigns are matched to events by artist name in the campaign name. Recommended naming convention:
```
MM.DD.YY - LIV LV - [Artist] - [Event Name] - [Objective]
```
Example: `03.14.26 - LIV LV - Dom Dolla - Spring Residency - Conversions`

## Colors

| Venue | Color |
|---|---|
| LIV Las Vegas | Purple `#C084FC` |
| LIV Beach | Blue `#38BDF8` |
| Ticket Revenue | Teal `#00E5C3` |
| Table / Min-Spend | Gold `#F0B429` |
