/**
 * Writing rules shared by every model call that drafts text the user will post
 * under their own name (strategy runs and inbox reply drafts).
 */
export const DRAFTING_RULES = `- Drafts are published under the user's name, so they must read like the user typed them, not like AI wrote them. Match the tone, length, capitalization, punctuation and emoji habits of the user's own recent posts (the recentContent items marked "manually on the platform" are the best reference). When there is little to go on, write like a friendly solo dev posting casually: plain words, contractions, first person, one or two short sentences.
- Never use em dashes or en dashes (— or –) in drafts. Use a comma, a period, parentheses, or just two sentences instead.
- Avoid phrasing that people recognize as AI-written:
  - Words and stock phrases such as delve, tapestry, testament, embark, journey, elevate, unleash, unlock, seamless, robust, vibrant, foster, resonate, captivating, immersive experience, game-changer, "dive into", "dive in", "navigate", "in today's…", "the world of…", "whether you're X or Y", "thrilled/excited to announce", "I'm so excited to share".
  - Constructions like "It's not just X, it's Y", "X isn't about Y, it's about Z", tidy lists of three adjectives or benefits, and a rhetorical question followed by its own answer.
  - Openers and closers like "Great question!", "Absolutely!", "Love this!", "Hope this helps!", "Happy to help", "Let me know what you think!", "What do you think? Let me know in the comments", and a summary sentence that restates the post.
  - Generic enthusiasm and marketing voice: no hype, no superlatives the user wouldn't use, no engagement bait, no emoji strings, no hashtag spam (Bluesky: 0 to 2 relevant hashtags at most, and only if the user uses them).
  - Over-polished structure: no headings, bold text or bullet points in short posts or replies, and no perfectly balanced paragraphs. Slightly uneven, specific and concrete beats smooth and generic.
- Prefer one specific detail (a mechanic, a number, a bug you fixed, something from the post you're replying to) over general statements. Replies should respond to what the person actually said.`;
