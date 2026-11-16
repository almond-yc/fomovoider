# Hackathon browser demo

Serve this directory with any static host, or open `index.html` directly. No build, credentials, backend, dependencies, or network requests are required.

For a local preview: `python3 -m http.server 8080 --directory demo`.

Judge flow: choose a slop preset → prepare the Morning Brief → save/hide a post → compare the unfiltered feed → reach “You’re all caught up” → open Chats → simulate a reply.

This is a deliberately isolated browser walkthrough of the native app, not the production client. It follows the existing Morning Brief, finite feed, and unified inbox flows. Ana and Mei's feed text comes from `components/feed/sample-posts.ts`; the other content is fictional demo data. Filtering uses simple fixture-category matching rather than the live AI pipeline. Replies, saves, and hides are in-memory only and reset on reload. No authentication, real connector sync, encryption, external sending, or production data is exercised.

The inline content security policy blocks all network requests and form submissions. The demo makes no requests to the shared Convex deployment, which contains real account data.
