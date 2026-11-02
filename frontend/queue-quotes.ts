// The quotes the queue overlay shows while a player waits (docs/queue-overlay.md):
// 16 lines about hearing the other side, arguing to learn and changing your
// mind, approved by the founder on 2026-10-30. `source` is exactly what shows
// after the name: the work, then the year.
//
// Every line but Solzhenitsyn's is public domain: the originals are old, and
// each translation is our own or by a translator who died long ago.
// Solzhenitsyn's is one short, credited line from a 1975 speech. Check each
// line against a public-domain copy of its source before changing it.
export interface Quote {
  text: string;
  author: string;
  source: string;
}

export const QUOTES: readonly Quote[] = [
  {
    text: "He who knows only his own side of the case knows little of that.",
    author: "John Stuart Mill",
    source: "On Liberty, 1859",
  },
  {
    text: "Both teachers and learners go to sleep at their post, as soon as there is no enemy in the field.",
    author: "John Stuart Mill",
    source: "On Liberty, 1859",
  },
  {
    // Our translation of Medea, lines 199–200.
    text: "Whoever judges without hearing the other side is unjust, even if the judgment is just.",
    author: "Seneca",
    source: "Medea, c. 50 AD",
  },
  {
    // Diogenes Laërtius VII, tr. R. D. Hicks (1925).
    text: "The reason why we have two ears and only one mouth is that we may listen the more and talk the less.",
    author: "Zeno of Citium",
    source: "Lives of the Philosophers, c. 230 AD",
  },
  {
    // Our translation of « Tout comprendre rend très indulgent ».
    text: "To understand everything makes one very tolerant.",
    author: "Germaine de Staël",
    source: "Corinne, 1807",
  },
  {
    // Washington, 30 June 1975; he introduced it as an old Russian proverb.
    text: "The yes-man is your enemy, but your friend will argue with you.",
    author: "Aleksandr Solzhenitsyn",
    source: "Speech to the AFL-CIO, 1975",
  },
  {
    // Our translation.
    text: "The aim of an argument or a discussion should not be victory, but progress.",
    author: "Joseph Joubert",
    source: "Pensées, 1838",
  },
  {
    text: "Opinion in good men is but knowledge in the making.",
    author: "John Milton",
    source: "Areopagitica, 1644",
  },
  {
    text: "Give me the liberty to know, to utter, and to argue freely according to conscience, above all liberties.",
    author: "John Milton",
    source: "Areopagitica, 1644",
  },
  {
    // Tr. Benjamin Jowett (458a).
    text: "I am one of those who are very willing to be refuted if I say anything which is not true.",
    author: "Socrates",
    source: "Plato’s Gorgias, c. 380 BC",
  },
  {
    // Tr. George Long (VI.21).
    text: "If any man is able to convince me and show me that I do not think or act right, I will gladly change.",
    author: "Marcus Aurelius",
    source: "Meditations, c. 175 AD",
  },
  {
    text: "Liberty is meaningless where the right to utter one’s thoughts and opinions has ceased to exist.",
    author: "Frederick Douglass",
    source: "A Plea for Free Speech in Boston, 1860",
  },
  {
    // Our translation.
    text: "From things that differ comes the finest harmony.",
    author: "Heraclitus",
    source: "Fragment B8, c. 500 BC",
  },
  {
    text: "Every difference of opinion is not a difference of principle.",
    author: "Thomas Jefferson",
    source: "First Inaugural Address, 1801",
  },
  {
    // The dedication, with modern capitals.
    text: "I have always strenuously supported the right of every man to his own opinion, however different that opinion might be to mine.",
    author: "Thomas Paine",
    source: "The Age of Reason, 1794",
  },
  {
    // Our translation of fragment 10.
    text: "We are usually better persuaded by the reasons we have found ourselves than by those that came into the minds of others.",
    author: "Blaise Pascal",
    source: "Pensées, 1670",
  },
];
