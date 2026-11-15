# Fixtures

Built by hand from the documented examples and response schemas on docs.x.com (quickstarts for the home timeline, mentions, DM lookup and manage posts, the OAuth 2.0 PKCE page, the response-codes page, and the DM problem types in the OpenAPI spec), on 2026-11-15. None of these were recorded from the live API.

Constructed where X does not document an example:

- `error-reply-not-summoned.json`: the exact body X returns for a non-summoned reply is not documented; the connector maps any 403 on a reply to `not_permitted` regardless of the body.
- `error-out-of-credits.json`: X does not document the out-of-credits response. The connector treats HTTP 402, a `usage-capped` problem, any problem type containing `credit`, or a title/detail mentioning credits, balance or spending limits as `out_of_credits`.

The feed fixtures add one example of each post shape the mapper handles: a photo with alt text and a t.co link, a repost of a video, a quote, a long post (`note_tweet`), and a mention that replies with a GIF. They follow the v2 schemas, but the values are made up.

Replace these with scrubbed real recordings once a live account is connected.
