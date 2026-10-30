import { asset } from "./assets.ts";
import { inscribe } from "./landing-web.ts";
import { html, type SafeHtml } from "../../platform/html.ts";
import { MINIMUM_AGE, TERMS_VERSION } from "../identity/terms.ts";

// /privacy and /terms (production runbook step 9.1). Both follow the landing
// page's theme: they load landing.css for its tokens, fonts, header, footer and
// reveal, then legal.css for the long-form layout. Draft text for the founder
// and counsel to approve; it is not legal advice.

/** Text only the founder can supply or decide, visible until it is filled. */
const todo = (text: string) => html`<mark class="legal-todo">[${text}]</mark>`;
const entity = todo("Legal name of the business");
const address = todo("Business address in Québec");
const contactEmail = todo("Contact email");
const privacyEmail = todo("Privacy email");
const privacyOfficer = todo("Name and title of the person in charge");
const updated = html`<time datetime="2026-10-30">October 30, 2026</time>`;

interface Section {
  id: string;
  title: string;
  body: SafeHtml;
}
interface LegalPage {
  path: "/privacy" | "/terms" | "/cookies";
  title: string;
  description: string;
  lede: SafeHtml;
  glance: [title: string, text: string][];
  sections: Section[];
}

const link = (href: string, text: string) =>
  html`<a href="${href}">${text}</a>`;

/** Rows become cards on phones; each cell is labelled by its column. */
function table(caption: string, columns: string[], rows: SafeHtml[][]) {
  return html`<table class="legal-table"><caption>${caption}</caption><thead><tr>${columns.map((column) => html`<th scope="col">${column}</th>`)}</tr></thead><tbody>${rows.map(([first, ...rest]) => html`<tr><th scope="row">${first}</th>${rest.map((cell, index) => html`<td data-label="${columns[index + 1]}">${cell}</td>`)}</tr>`)}</tbody></table>`;
}
const cell = (text: string) => html`${text}`;

const pageLinks = [
  ["/privacy", "Privacy"],
  ["/terms", "Terms"],
  ["/cookies", "Cookies"],
] as const;

function render(origin: string, page: LegalPage) {
  const current = (href: string) =>
    href === page.path ? html` aria-current="page"` : "";
  const footer = [
    ["/topics", "Topics"],
    ["/coins", "Yap Coins"],
    ["/about", "About"],
    ...pageLinks,
  ] as const;
  return html`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="color-scheme" content="dark"><meta name="theme-color" content="#000000"><title>${page.title} · YAP Arena</title><meta name="description" content="${page.description}"><link rel="canonical" href="${origin}${page.path}"><link rel="preload" href="/assets/landing/fonts/headline.woff2" as="font" type="font/woff2" crossorigin><link rel="stylesheet" href="${asset("landing.css")}"><link rel="stylesheet" href="${asset("legal.css")}"></head><body class="landing legal"><a class="skip-link" href="#main">Skip to content</a><header class="landing-header landing-container legal-header"><a class="landing-brand" href="/"><img src="${asset("landing/yaparena-logo.png")}" width="575" height="151" alt="YAP Arena"></a><nav class="legal-switch" aria-label="Legal">${pageLinks.map(([href, text]) => html`<a href="${href}"${current(href)}>${text}</a>`)}</nav></header><main id="main" class="legal-main landing-container"><header class="legal-hero"><p class="legal-eyebrow reveal">YAP ARENA · LEGAL</p><h1 class="legal-title reveal reveal-2"><span class="sr-only">${page.title}</span><span aria-hidden="true">${inscribe(page.title)}</span></h1><p class="legal-lede reveal reveal-3">${page.lede}</p><dl class="legal-meta reveal reveal-4"><div><dt>Updated</dt><dd>${updated}</dd></div><div><dt>Version</dt><dd>${TERMS_VERSION}</dd></div></dl><ul class="legal-glance reveal reveal-5">${page.glance.map(([title, text]) => html`<li><strong>${title}</strong><span>${text}</span></li>`)}</ul></header><div class="legal-layout"><nav class="legal-toc" aria-labelledby="legal-toc-title"><h2 id="legal-toc-title">ON THIS PAGE</h2><ol>${page.sections.map((section) => html`<li><a href="#${section.id}">${section.title}</a></li>`)}</ol></nav><article class="legal-body">${page.sections.map((section) => html`<section id="${section.id}" aria-labelledby="${section.id}-title"><h2 id="${section.id}-title">${section.title}</h2>${section.body}</section>`)}<a class="legal-top" href="#main">Back to top <span aria-hidden="true">↑</span></a></article></div></main><footer class="landing-footer landing-container"><nav aria-label="Site">${footer.map(([href, text]) => html`<a href="${href}"${current(href)}>${text}</a>`)}<span>Play money</span></nav></footer></body></html>`.toString();
}

// ---------------------------------------------------------------------------
// Privacy policy

const processors = table(
  "Service providers and what each receives",
  ["Provider", "What it does for us", "What it receives", "Where"],
  [
    [
      cell("Supabase"),
      cell("Hosts our database."),
      cell(
        "Everything in our database: accounts, profiles, debates, chat, transcripts, outlines, Yap Coins records and measurement.",
      ),
      cell("United States (Ohio)"),
    ],
    [
      cell("Render"),
      cell("Runs our website, background jobs and replay encoder."),
      cell(
        "Every request to yaparena.com, including your IP address and browser details in its request logs, and the recordings it prepares for replay.",
      ),
      cell("United States (Ohio)"),
    ],
    [
      cell("Auth0 (Okta)"),
      cell("Signs you in with an email code or Google."),
      cell(
        "Your email address, your sign-in identifier, the IP address and browser you sign in from and, if you use Google, what Google shares with it.",
      ),
      cell("United States"),
    ],
    [
      cell("Google"),
      cell("“Continue with Google”, only if you choose it."),
      html`Google confirms your email address to Auth0; YAP Arena takes only your email address from it. Google learns that you signed in to YAP Arena. See ${link("https://policies.google.com/privacy", "Google’s privacy policy")}.`,
      cell("Google’s infrastructure"),
    ],
    [
      cell("Resend"),
      cell("Sends the sign-in code emails for Auth0."),
      cell("Your email address and the one-time code."),
      cell("United States (Virginia)"),
    ],
    [
      cell("LiveKit"),
      cell(
        "Carries live video and audio, records debates and runs our transcription agent.",
      ),
      cell(
        "Debaters’ video and audio with an internal account number (not your name or email), live captions, and viewers’ connection details such as IP address.",
      ),
      cell("United States"),
    ],
    [
      cell("Deepgram"),
      cell("Turns debaters’ speech into text, through LiveKit."),
      cell("The audio of the speaker whose turn it is."),
      html`${todo("Confirm region")}`,
    ],
    [
      cell("ElevenLabs"),
      cell(
        "Alternative speech-to-text. Not used in production today; we may switch to it.",
      ),
      cell("The audio of the speaker whose turn it is, if we switch."),
      html`${todo("Confirm region")}`,
    ],
    [
      cell("Anthropic"),
      cell("Its Claude models write the AI outline of each turn."),
      cell(
        "The transcript of each turn, the debate’s question and the arguments already made in it. Not your name, handle or email.",
      ),
      html`${todo("Confirm region")}`,
    ],
    [
      cell("Cloudflare"),
      cell(
        "Runs our domain’s DNS, stores recordings and replays (R2) and delivers replays.",
      ),
      cell(
        "Recordings and replay files, and viewers’ IP address and browser details when they watch a replay.",
      ),
      html`R2 storage location ${todo("Confirm location")}; delivery from Cloudflare’s worldwide network`,
    ],
  ],
);

const retention = table(
  "How long we keep each kind of information",
  ["Information", "How long"],
  [
    [
      cell("Account, profile, follows, notifications and Debating settings"),
      cell("Until you delete your account."),
    ],
    [
      cell("Terms acceptance"),
      cell("With your account, as a record of what you accepted and when."),
    ],
    [
      cell("Sign-in session"),
      cell("7 days at most; signing out ends it on that device."),
    ],
    [
      cell("Sign-in steps in progress"),
      cell("10 minutes, used once, and deleted within the next hour."),
    ],
    [cell("Account activity log"), cell("90 days.")],
    [
      cell("Debate recordings and replays"),
      html`Kept with the debate. ${todo("Founder decision: retention period for recordings and replays")}`,
    ],
    [
      cell("Transcripts with word timings"),
      html`Kept with the debate, and deleted with the speaker’s account. ${todo("Founder decision: retention period for transcripts")}`,
    ],
    [
      cell("AI outline"),
      cell(
        "Kept with the debate. A debater’s flags on it are deleted with their account.",
      ),
    ],
    [
      cell("Provider comparison transcripts"),
      cell("90 days. Only made while we compare two speech-to-text providers."),
    ],
    [cell("Transcription delivery receipts"), cell("7 days.")],
    [
      cell("Chat and likes"),
      cell(
        "365 days. A message that is the subject of a report is kept as long as the report.",
      ),
    ],
    [
      cell("Reports, appeals and moderation records"),
      cell(
        "365 days after the decision. An open report or appeal is kept until it is decided.",
      ),
    ],
    [cell("Finished matchmaking queue entries"), cell("30 days.")],
    [
      cell("Challenges and the debates you took part in"),
      html`Kept with the debate. ${todo("Founder decision: retention period for challenges and debate participation")}`,
    ],
    [
      cell("Yap Coins records"),
      html`Kept in a ledger that can’t be edited, so balances stay correct. ${todo("Founder decision: what happens to Yap Coins records after account deletion")}`,
    ],
    [
      cell("Analytics (only if you accept analytics cookies)"),
      cell(
        "Events and watch sessions 90 days; an unused consent 180 days; staff reviews that classify accounts in measurement 365 days. Turning analytics off deletes that browser’s measurements at once.",
      ),
    ],
    [cell("Database backups"), cell("7 days, then overwritten.")],
    [
      cell("Hosting and provider logs"),
      html`As set by each provider. ${todo("Confirm Render, LiveKit and Cloudflare log retention")}`,
    ],
  ],
);

const visibility = table(
  "Public and private information",
  ["Information", "Who can see it"],
  [
    [
      cell("Username, handle and bio"),
      cell("Everyone, including people who aren’t signed in."),
    ],
    [
      cell("Debates you take part in"),
      cell(
        "Everyone: video, voice, captions, the AI outline and your flags on it, live and in the replay.",
      ),
    ],
    [cell("Chat messages"), cell("Everyone, with your username.")],
    [cell("Likes"), cell("Everyone sees the count, not who liked.")],
    [
      cell("Yap Coins positions"),
      cell(
        "Only you. Each turn’s combined results are public once revealed, without names.",
      ),
    ],
    [cell("Reports and appeals"), cell("You and our moderators.")],
    [
      cell("Email, sign-in methods, notifications and analytics"),
      cell("Only you and the staff who run YAP Arena."),
    ],
  ],
);

const privacy: LegalPage = {
  path: "/privacy",
  title: "Privacy policy",
  description:
    "What YAP Arena collects, why, who processes it, where it is stored and how long we keep it.",
  lede: html`YAP Arena is a live debate site run from Québec. This policy explains, in plain terms, what we collect when you watch, sign in or debate, why we collect it, who processes it for us, where it is stored, how long we keep it and how to reach us about it.`,
  glance: [
    [
      "Debates are public",
      "Debaters’ video, voice, transcript and AI outline are shown live and in public replays.",
    ],
    [
      "Stored in the United States",
      "Our database, servers, video and sign-in providers keep information outside Québec and Canada.",
    ],
    [
      "No ads, no selling",
      "We don’t sell personal information or use it for advertising.",
    ],
    [
      "Analytics cookies are your choice",
      "They stay off until you accept them, and you can turn them off and delete their data anytime.",
    ],
  ],
  sections: [
    {
      id: "who",
      title: "Who we are",
      body: html`<p>YAP Arena (yaparena.com) is operated by ${entity}, ${address} (“YAP Arena”, “we”, “us”). This policy covers yaparena.com and the sign-in, live video and replay services that are part of it.</p><p>The person in charge of the protection of personal information at YAP Arena is ${privacyOfficer}. You can reach them at ${privacyEmail}. Under Québec law, this is the person with the highest authority in the business unless that role is delegated in writing.</p>`,
    },
    {
      id: "collect",
      title: "Information we collect",
      body: html`<h3>Information you give us</h3><ul><li><strong>Account.</strong> Your email address, confirmed by a one-time code or by Google. From Google we take only your email address. We never ask for or store a password.</li><li><strong>Profile.</strong> Your username, your permanent handle and an optional bio, and your confirmation that you are ${MINIMUM_AGE} or older and accept the Terms of Use, with its version and time.</li><li><strong>Debates.</strong> The video and audio of your debates; the transcript of your turns with the time of each word; the AI outline of your arguments and any flags you add to it; the language you debate in and your consent to recording and transcription.</li><li><strong>Taking part.</strong> Chat messages, likes, reports and appeals, the topics and people you follow, and the challenges, queue entries and times you propose.</li><li><strong>Yap Coins.</strong> The positions you take in each turn of a debate and their results.</li><li><strong>Messages to us.</strong> What you write when you contact us.</li></ul><h3>Information we collect automatically</h3><ul><li><strong>Sign-in and security.</strong> A random session identifier in a cookie, and the sign-in methods and activity on your account (shown in your account settings).</li><li><strong>Device and connection.</strong> Your IP address and browser details reach our hosting and video providers with each request, and they keep them in their logs for security and troubleshooting. We don’t store your IP address in our database.</li><li><strong>Debating readiness.</strong> Whether your camera and microphone check passed, and whether you are on the site to receive a challenge.</li><li><strong>Analytics, only if you accept analytics cookies.</strong> Which public pages you open, live and replay watch time, replay starts, matches, follows, reports and return visits. We don’t record your email, handle, IP address, search text, chat or report text in analytics.</li></ul><h3>Information from others</h3><ul><li><strong>Sign-in providers.</strong> Auth0, and Google if you use it, confirm your email address.</li><li><strong>Other people on YAP Arena.</strong> Reports that name your messages or debates, and moderators’ decisions about them.</li><li><strong>Our AI providers.</strong> The captions and AI outline made from what you say in a debate.</li></ul><p>We don’t ask for your date of birth, a payment card, government ID, your contacts or your precise location.</p>`,
    },
    {
      id: "use",
      title: "How we use it",
      body: html`<ul><li><strong>To run your account</strong>: sign-in, your profile, follows and notifications.</li><li><strong>To run debates</strong>: matching debaters, carrying live video, recording it and publishing the replay.</li><li><strong>To caption and outline debates</strong>: speech-to-text for captions, and an AI outline that summarizes each side’s arguments.</li><li><strong>To run Yap Coins</strong>, the play-money game on each debate.</li><li><strong>To keep the community safe</strong>: chat, reports, moderation, appeals, rate limits and abuse prevention.</li><li><strong>To improve YAP Arena</strong>, with analytics cookies only if you accept them.</li><li><strong>To meet legal obligations</strong> and answer lawful requests.</li></ul><p>We use your information only for these purposes, or for another purpose you consent to or the law allows.</p>`,
    },
    {
      id: "public",
      title: "What others can see",
      body: html`<div class="legal-note"><p>Debates are public. When you debate, anyone can watch you live and in the replay afterwards: your video, your voice, your username and handle, the captions of what you say and the AI outline of your arguments. Debates can be shared by link and QR code.</p></div>${visibility}<p>Before your first debate, the Debating card in your account settings asks for your consent to recording and public replay. You can withdraw it anytime for future debates. Debates already held keep their recording, transcript and outline for the periods in ${link("#retention", "How long we keep it")}. Viewers can make their own copies of what they watch, for example by recording their screen, and we can’t control those copies.</p>`,
    },
    {
      id: "ai",
      title: "AI features",
      body: html`<ul><li><strong>Captions.</strong> A speech-to-text provider, Deepgram (or ElevenLabs, if we switch), turns the active speaker’s audio into text.</li><li><strong>AI outline.</strong> Anthropic’s Claude models summarize each turn into the arguments shown beside the debate. They receive the transcript, the debate’s question and the arguments already made, not your name, handle or email.</li><li><strong>Mistakes.</strong> Captions and outlines are automatic and can be wrong. Debaters can flag mistakes in the outline, and the flag is shown publicly.</li><li><strong>No decisions about you.</strong> The outline summarizes what was said. It doesn’t pick a winner, and it isn’t used to make decisions about you or your account.</li><li><strong>Training.</strong> We don’t use your content to train AI models. ${todo("Confirm that Deepgram, ElevenLabs and Anthropic don’t train on our data under their API terms")}</li></ul>`,
    },
    {
      id: "sharing",
      title: "How we share it",
      body: html`<p><strong>We don’t sell or rent personal information, and we don’t share it for advertising.</strong> We share it only in these cases:</p><ul><li><strong>Service providers</strong> that run YAP Arena for us, listed below. Each receives only what it needs to provide its service.</li><li><strong>Everyone, for public content</strong>: the profile, debates and chat described in ${link("#public", "What others can see")}.</li><li><strong>The law and safety</strong>: when the law requires it, or to protect people’s safety, investigate abuse or defend our rights.</li><li><strong>A business change</strong>: if YAP Arena is merged, sold or reorganized, under the same protections.</li></ul>${processors}<p>${todo("Confirm each provider’s data processing terms and that none may use our data for its own purposes")}</p>`,
    },
    {
      id: "transfers",
      title: "Where it is stored",
      body: html`<p>Your information is stored and processed <strong>outside Québec and Canada</strong>. Our database and servers are in Ohio, in the United States, and our sign-in, email and video providers keep information in the United States. Our speech-to-text, AI and replay storage providers may process it in the United States or other countries ${todo("Confirm Deepgram, Anthropic and Cloudflare R2 locations")}. Information held abroad is subject to the laws of that country and may be accessed by its courts and authorities.</p><p>Before sending personal information outside Québec, we assess whether it will be adequately protected, taking into account its sensitivity, the purpose, the safeguards in place and the laws that apply, and we rely on written agreements with our providers. ${todo("Founder: complete the privacy impact assessment for transfers outside Québec")}</p>`,
    },
    {
      id: "retention",
      title: "How long we keep it",
      body: html`${retention}<p>Daily cleanup jobs delete information when its period ends. Deleted information can remain in database backups until they expire.</p>`,
    },
    {
      id: "cookies",
      title: "Cookies",
      body: html`<p>We use strictly necessary cookies to sign you in, keep YAP Arena secure and remember your choices. We use one analytics cookie, only if you accept it in the cookie banner. We don’t use advertising or third-party tracking cookies.</p><p>The ${link("/cookies", "Cookie Policy")} lists every cookie and how long it lasts. Change your choice anytime with <strong>Cookie settings</strong> at the bottom of any page.</p>`,
    },
    {
      id: "rights",
      title: "Your rights and choices",
      body: html`<p>You can ask to access the personal information we hold about you, to correct it, to receive it in a structured, commonly used format, to stop its use or have it deleted, and to have links to it de-indexed where the law allows. You can also withdraw a consent you gave.</p><ul><li><strong>Download your data</strong> from your account’s Privacy settings: a file with your profile, sign-in methods, follows, notifications, terms acceptance and account activity. Chat, reports, debate participation and Yap Coins records aren’t in the file yet; ask us for them.</li><li><strong>Correct your profile</strong> in your account settings. Your handle is permanent; ask us if it must change.</li><li><strong>Turn analytics cookies off</strong> with Cookie settings; it deletes that browser’s measurements.</li><li><strong>Withdraw debating consent</strong> in the Debating card in your account settings.</li><li><strong>Delete your account</strong> by emailing ${privacyEmail} from the address you sign in with. Deletion is done by hand for now: we confirm the request, end your sessions, delete your profile and sign-in details, and delete or de-identify the other information tied to your account, except what the periods above say we keep. ${todo("Founder decision: account deletion rules (prompt 12c)")}</li></ul><p>We answer requests within 30 days. We may ask you to confirm your identity first.</p>`,
    },
    {
      id: "security",
      title: "How we protect it",
      body: html`<p>Connections use HTTPS. We don’t store passwords; sign-in uses one-time email codes or Google through Auth0. Sessions are random values that we can end at any time, and staff access is limited by role. Recordings are stored privately and served only through short-lived signed links.</p><p>No system is perfectly secure. If a confidentiality incident creates a risk of serious injury, we will notify the Commission d’accès à l’information and the people affected, and we keep a register of incidents.</p>`,
    },
    {
      id: "age",
      title: "Age",
      body: html`<p>YAP Arena is for people ${MINIMUM_AGE} and older. We don’t knowingly collect information from anyone younger. If we learn that an account belongs to someone under ${MINIMUM_AGE}, we close it and delete its information. Contact us at ${privacyEmail} if you believe this has happened.</p>`,
    },
    {
      id: "changes",
      title: "Changes to this policy",
      body: html`<p>When we change this policy, we post the new version here with its date. If a change affects how we use information you have already given us, we tell you in YAP Arena before it applies and ask for your consent again where the law requires it.</p>`,
    },
    {
      id: "contact",
      title: "Contact and complaints",
      body: html`<p>Questions, requests and complaints about privacy go to ${privacyOfficer} at ${privacyEmail}, or by mail to ${entity}, ${address}.</p><p>If you aren’t satisfied with our answer, you can complain to the ${link("https://www.cai.gouv.qc.ca", "Commission d’accès à l’information du Québec")} or to the ${link("https://www.priv.gc.ca", "Office of the Privacy Commissioner of Canada")}.</p>`,
    },
  ],
};

// ---------------------------------------------------------------------------
// Terms of use

const terms: LegalPage = {
  path: "/terms",
  title: "Terms of use",
  description:
    "The rules for using YAP Arena: eligibility, public debates, conduct, Yap Coins and your content.",
  lede: html`These terms are the agreement between you and ${entity} for using YAP Arena. Please read them together with the ${link("/privacy", "Privacy Policy")}.`,
  glance: [
    [
      `${MINIMUM_AGE} and older`,
      `You must be at least ${MINIMUM_AGE} to create an account or use YAP Arena.`,
    ],
    [
      "Debates are public",
      "Debates are recorded and replayed publicly, with captions and an AI outline.",
    ],
    [
      "Yap Coins are play money",
      "They have no cash value and can’t be bought, sold or withdrawn.",
    ],
    [
      "Argue the idea",
      "No harassment, hate, threats, spam or sharing other people’s private information.",
    ],
  ],
  sections: [
    {
      id: "agreement",
      title: "Agreement",
      body: html`<p>By creating an account or using YAP Arena, you accept these terms and the ${link("/privacy", "Privacy Policy")}. If you don’t accept them, don’t use YAP Arena. New accounts confirm this when they claim their handle.</p><p>YAP Arena is operated by ${entity}, ${address} (“YAP Arena”, “we”, “us”).</p>`,
    },
    {
      id: "eligibility",
      title: "Eligibility and your account",
      body: html`<ul><li>You must be <strong>${MINIMUM_AGE} or older</strong> and able to enter into a contract.</li><li>One person per account. Use your own email address or Google account and keep access to it secure: anyone who can read your email or use your Google account can sign in as you.</li><li>Your handle is permanent. Don’t choose a username or handle that impersonates someone, misleads people about who you are or breaks the conduct rules; we may change or remove one that does.</li><li>You are responsible for what happens through your account. Tell us at ${contactEmail} if you think someone else is using it.</li></ul>`,
    },
    {
      id: "debates",
      title: "Debates, recording and replay",
      body: html`<div class="legal-note"><p>Debates on YAP Arena are public. They are shown live, <strong>recorded on video and audio</strong> and <strong>published as replays</strong> that anyone can watch and share.</p></div><ul><li>Each turn is transcribed into captions and summarized in an <strong>AI outline</strong>. Both are automatic and can be wrong; they are not statements by YAP Arena or by the debater. YAP Arena does not declare winners.</li><li>To debate, you must agree to recording, public replay, transcription and the AI outline in the Debating card in your account settings.</li><li>Only show and say what you have the right to share. Don’t put other people on camera without their permission, and don’t play music, video or other material you don’t have the rights to.</li><li>We may pause, end, cancel or remove a debate, for example when it breaks these terms or a technical problem affects it.</li></ul>`,
    },
    {
      id: "content",
      title: "Your content and our licence",
      body: html`<p>You keep ownership of what you create on YAP Arena: your debate video and audio, what you say and write, your chat messages and your profile (“your content”).</p><p>You grant ${entity} a non-exclusive, worldwide, royalty-free licence to host, store, record, reproduce, transcribe, caption, summarize (including with AI), adapt for format and length, publish, display, stream and distribute your content on YAP Arena and in links and previews of it, and to have our service providers do so for us. ${todo("Founder: say whether YAP Arena may also use debate clips to promote itself elsewhere")}</p><p>The licence lasts as long as we keep your content under the Privacy Policy, and ends when it is deleted, except for copies in backups until they expire and copies others made while it was public. To the extent the law allows, you agree not to assert moral rights against changes needed only to format, caption or summarize your content.</p><p>You confirm that you have the rights needed to grant this licence. Other people’s debates and content belong to them: you may watch and share links to them, but don’t copy, re-publish or sell them beyond what the law allows.</p>`,
    },
    {
      id: "conduct",
      title: "Conduct",
      body: html`<p>Argue the idea, not the person. On YAP Arena, including debates, chat, profiles and usernames, you must not:</p><ul><li><strong>Harass</strong>, bully or threaten anyone, or encourage violence or self-harm.</li><li>Post <strong>hate</strong>: attacks on people for their race, ethnicity, national origin, religion, sex, gender identity, sexual orientation, disability, age or other protected characteristic.</li><li>Share <strong>private information</strong> about someone, such as their address, phone number or documents, or images of them without their consent.</li><li>Post <strong>spam</strong>, scams or misleading links, or impersonate a person or organization.</li><li>Show sexual content or nudity, or anything illegal.</li><li><strong>Manipulate</strong> YAP Arena: use bots or several accounts, coordinate to distort Yap Coins results, or try to take a position in your own debate.</li><li>Interfere with the service: attack, overload or probe it, get around limits or bans, or collect other people’s information by automated means.</li></ul><p>Anyone can report a chat message or a debate. Moderators may remove chat, pause a debate’s chat, restrict your community access for 7 days, or suspend or close your account. If a decision affects your chat or account, you can appeal once within 30 days from ${link("/account/moderation", "your reports and appeals")}; a different moderator decides.</p>`,
    },
    {
      id: "coins",
      title: "Yap Coins",
      body: html`<div class="legal-note"><p><strong>Yap Coins are play money.</strong> They have no cash value and are not money, property, a currency or an investment.</p></div><ul><li>Every account receives a welcome grant of Yap Coins. You use them to answer each turn of a debate in a play-money game.</li><li>Yap Coins <strong>can’t be bought, sold, withdrawn, transferred to another account or exchanged</strong> for money, prizes or anything else of value. YAP Arena has no real-money features.</li><li>We may change the game’s rules, correct balances affected by errors, and adjust or remove Yap Coins obtained by breaking these terms. Closing an account ends its Yap Coins without compensation.</li><li>If YAP Arena ever offers anything of real value, it will come with separate terms that you accept first.</li></ul>`,
    },
    {
      id: "service",
      title: "Our service",
      body: html`<p>YAP Arena is new and changes often. We may add, change or remove features, and the service may be interrupted for maintenance or because of problems with our providers. We provide YAP Arena “as is” and don’t promise that it will always be available or free of errors.</p><p>What debaters and other users say is their own opinion. YAP Arena doesn’t endorse it, and it isn’t professional advice.</p>`,
    },
    {
      id: "ending",
      title: "Suspension and ending your account",
      body: html`<p>You can stop using YAP Arena at any time and ask us to delete your account at ${contactEmail} (see the ${link("/privacy#rights", "Privacy Policy")}).</p><p>We may remove content, or suspend or close an account, if it breaks these terms, if the law requires it, or to protect people or YAP Arena. We tell you why unless the law or someone’s safety prevents it. When an account ends, its Yap Coins end, and its debates remain public under the Privacy Policy’s periods unless we remove them.</p>`,
    },
    {
      id: "liability",
      title: "Liability",
      body: html`<p>To the extent the law allows, ${entity} is not liable for indirect or consequential losses, or for what other users say or do. Nothing in these terms limits rights you have as a consumer under the laws of Québec or Canada that can’t be waived, or our liability for our own intentional or gross fault.</p>`,
    },
    {
      id: "changes",
      title: "Changes to these terms",
      body: html`<p>We may update these terms. We post the new version here with its date and version. If a change is significant, we tell you in YAP Arena before it applies and ask you to accept the new version to keep using your account.</p>`,
    },
    {
      id: "law",
      title: "Governing law",
      body: html`<p>These terms are governed by the laws of Québec and the federal laws of Canada that apply there. Disputes go to the courts of the judicial district of ${todo("Judicial district")}, Québec, without limiting a consumer’s right to bring a claim where they live.</p>`,
    },
    {
      id: "contact",
      title: "Contact",
      body: html`<p>Questions about these terms go to ${contactEmail}, or by mail to ${entity}, ${address}.</p>`,
    },
  ],
};

// ---------------------------------------------------------------------------
// Cookie policy

const cookieCategories = table(
  "Cookie categories",
  ["Category", "What it does", "Your choice"],
  [
    [
      cell("Strictly necessary"),
      cell(
        "Signs you in, keeps your session secure, limits abuse and remembers your choices, such as your cookie choice and captions setting.",
      ),
      cell("Always on. YAP Arena can’t work without them."),
    ],
    [
      cell("Analytics"),
      cell(
        "Counts which debates and pages people find, watch time, replay starts and return visits, so we can see what works and improve YAP Arena.",
      ),
      cell("Off until you accept. You can turn it off anytime."),
    ],
    [
      cell("Advertising"),
      cell("None. We don’t use advertising or cross-site tracking cookies."),
      cell("Not used."),
    ],
  ],
);

const cookieList = table(
  "Cookies set by yaparena.com",
  ["Cookie", "Category", "Purpose", "Duration"],
  [
    [
      cell("__Host-session"),
      cell("Strictly necessary"),
      cell("Keeps you signed in. It holds a random value, never your email."),
      cell("7 days, or until you sign out"),
    ],
    [
      cell("__Host-sign-in"),
      cell("Strictly necessary"),
      cell("Ties a sign-in in progress to your browser, for security."),
      cell("10 minutes"),
    ],
    [
      cell("yap_media_guard"),
      cell("Strictly necessary"),
      cell(
        "A signed random value that limits how fast one browser can load pages and video, to prevent abuse.",
      ),
      cell("15 minutes"),
    ],
    [
      cell("__Host-measurement"),
      cell("Analytics"),
      cell(
        "Set only after you accept analytics. A random value that groups this browser’s measurements; we store only a fingerprint of it.",
      ),
      cell("180 days, or until you turn analytics off"),
    ],
  ],
);

const storageList = table(
  "Similar technologies on your device",
  ["Name", "Category", "Purpose", "Duration"],
  [
    [
      cell("yaparena-measurement-declined"),
      cell("Strictly necessary"),
      cell("Remembers that you rejected analytics, so we don’t ask again."),
      cell("Until you clear site data"),
    ],
    [
      cell("yap:live-captions"),
      cell("Strictly necessary"),
      cell("Remembers whether you turned captions on or off."),
      cell("Until you clear site data"),
    ],
    [
      cell("yaparena-stake-defaults, -review, -explained"),
      cell("Strictly necessary"),
      cell(
        "Your Yap Coins ticket defaults, whether to show the review step, and that you’ve seen the explanation.",
      ),
      cell("Until you clear site data"),
    ],
    [
      cell("yaparena-results-seen"),
      cell("Strictly necessary"),
      cell("Which Yap Coins results you’ve already seen."),
      cell("Until you clear site data"),
    ],
    [
      cell("yaparena-auth-return, yaparena-coin-confirmation"),
      cell("Strictly necessary"),
      cell(
        "The page to return to after signing in, and a Yap Coins confirmation in progress.",
      ),
      cell("Until you close the tab"),
    ],
    [
      cell("media-speaker"),
      cell("Strictly necessary"),
      cell("While you debate: your chosen camera, microphone and mute state."),
      cell("Until you close the tab"),
    ],
    [
      cell("Offline page"),
      cell("Strictly necessary"),
      cell(
        "Our service worker keeps a copy of the offline page and its stylesheet, shown if you lose your connection.",
      ),
      cell("Until we update it or you clear site data"),
    ],
  ],
);

const cookiePolicy: LegalPage = {
  path: "/cookies",
  title: "Cookie policy",
  description:
    "The cookies and similar technologies YAP Arena uses, why, and how to change your choice.",
  lede: html`This policy explains the cookies and similar technologies YAP Arena uses, why we use them and how you control them. It is part of our ${link("/privacy", "Privacy Policy")}.`,
  glance: [
    [
      "Essential by default",
      "Only the cookies YAP Arena needs to work are on until you choose.",
    ],
    [
      "Analytics is your choice",
      "Accept or reject it in the banner; both buttons weigh the same.",
    ],
    [
      "No advertising cookies",
      "No ad networks, no cross-site tracking, no third-party analytics.",
    ],
    [
      "Change it anytime",
      "Cookie settings is at the bottom of every page and in your account.",
    ],
  ],
  sections: [
    {
      id: "what",
      title: "What cookies are",
      body: html`<p>Cookies are small text files a website stores in your browser. They let the site recognize your browser between pages, for example to keep you signed in. Some last only for a visit; others stay for a set time.</p><p>Websites also use similar technologies, such as your browser’s local and session storage, which keep small values on your device. This policy covers both, and calls them all “cookies” where the difference doesn’t matter.</p>`,
    },
    {
      id: "categories",
      title: "How we use cookies",
      body: html`${cookieCategories}<p>All our cookies are first-party: yaparena.com sets them, and they are sent only to yaparena.com.</p>`,
    },
    {
      id: "list",
      title: "The cookies we set",
      body: html`${cookieList}<p>Our cookies are marked HttpOnly and Secure, so page scripts can’t read them and they are only sent over HTTPS.</p>`,
    },
    {
      id: "storage",
      title: "Similar technologies",
      body: html`<p>These values stay on your device. We don’t send them to our servers except where the purpose says so, and none of them is used for analytics or advertising.</p>${storageList}`,
    },
    {
      id: "third-parties",
      title: "Other services",
      body: html`<p>We don’t load third-party scripts, analytics or advertising on yaparena.com.</p><ul><li><strong>Sign-in.</strong> When you sign in, you go to our sign-in provider, Auth0, at auth.yaparena.com. Auth0 sets its own cookies there to run sign-in. If you choose Google, Google may set cookies on its own sites. Their policies apply: ${link("https://www.okta.com/privacy-policy/", "Okta (Auth0)")} and ${link("https://policies.google.com/technologies/cookies", "Google")}.</li><li><strong>Video and replays.</strong> Live video comes from LiveKit and replays from Cloudflare. Your browser connects to them directly, so they receive your IP address, but they don’t set cookies on yaparena.com.</li></ul>`,
    },
    {
      id: "choices",
      title: "Your choices",
      body: html`<ul><li><strong>The banner.</strong> On your first visit, choose <strong>Accept all</strong>, <strong>Reject all</strong> or <strong>Customize</strong>. Until you choose, analytics stays off.</li><li><strong>Cookie settings.</strong> Change your choice anytime with <strong>Cookie settings</strong> at the bottom of any page, in your account’s Privacy tab, or ${link("/home#cookie-settings", "here")}. Turning analytics off deletes the measurements collected through that browser.</li><li><strong>Your browser.</strong> You can block or delete cookies in your browser’s settings. If you block strictly necessary cookies, you won’t be able to sign in.</li></ul><p>Your choice is saved for each browser. If you use another browser or device, or clear your cookies, we ask again.</p>`,
    },
    {
      id: "changes",
      title: "Changes to this policy",
      body: html`<p>When we change how we use cookies, we update this page and its date. If we add a new kind of optional cookie, we ask for your choice again.</p>`,
    },
    {
      id: "contact",
      title: "Contact",
      body: html`<p>Questions about cookies go to ${privacyEmail}.</p>`,
    },
  ],
};

export const renderPrivacy = (origin: string) => render(origin, privacy);
export const renderTerms = (origin: string) => render(origin, terms);
export const renderCookies = (origin: string) => render(origin, cookiePolicy);
