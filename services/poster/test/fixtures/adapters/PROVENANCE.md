# Adapter fixture provenance

Every fixture here is one recorded HTTP response: `{ status, headers?, body }`,
keyed by scenario name. The adapters' contract tests replay them through an
injected `fetch`, so a classification change cannot pass without a fixture that
exercises it.

## These are documented shapes, not live recordings

**Read this before trusting a fixture.** They were built from each provider's
published documentation on **2026-09-26**, not captured from a live account. S09
is split (D-082): the live half re-records them from real responses and notes any
shape that differed. Until then, a fixture proves our *classification* is right
given that shape — it does not prove the shape is right.

Two scenarios are ours rather than the provider's, and stay synthetic after the
live half: `echoes_credential` in both `upload.json` and `post.json`. No real
provider is expected to echo an API key back, but rule 5 says a credential must
never reach `raw`, and the only way to test that is to feed one in deliberately.

## Sources

| File | Endpoint | Documentation |
|---|---|---|
| `upload-post/upload.json` | `POST /api/upload` | <https://docs.upload-post.com/api/upload-video/> |
| `upload-post/history.json` | `GET /api/uploadposts/history` | <https://docs.upload-post.com/api/upload-history/> |
| `upload-post/users.json` | `GET /api/uploadposts/users` | <https://docs.upload-post.com/api/user-profiles/> |
| `ayrshare/post.json` | `POST /api/post` | <https://www.ayrshare.com/docs/rest-api/endpoints/post> |
| `ayrshare/history.json` | `GET /api/history` | <https://www.ayrshare.com/docs/apis/history/get-history> |
| `ayrshare/user.json` | `GET /api/user` | <https://www.ayrshare.com/docs/apis/user/profile-details> |

Error code 137 in `ayrshare/post.json` comes from
<https://www.ayrshare.com/docs/help-center/technical-support/dealing_with_duplicate_posts.md>.

## Refreshing from live responses

1. Set the provider keys in `.env.local` (see `docs/S09-acceptance.md`).
2. `pnpm -F @suite/poster-service test:live` — it prints each response it receives.
3. Replace the matching scenario body, keeping the scenario key.
4. Scrub before committing: the profile handle, the account ids, and anything that
   looks like a token. `test/adapter-fixtures.test.ts` fails if a fixture contains
   a string shaped like a live key.
5. Re-run `pnpm -F @suite/poster-service test`. A fixture whose shape changed
   should make a classification test fail — if nothing fails, the new shape was
   not actually exercised.
