/**
 * Porter stemmer (M. F. Porter, 1980), the same algorithm SQLite FTS5's `porter`
 * tokenizer uses.
 *
 * We stem in JS rather than letting FTS5 do it so that the SQLite and the pure-JS
 * backends see byte-identical terms: identical terms → identical BM25 → the
 * fallback on Node 20 ranks exactly like SQLite on Node 22+.
 */

const cache = new Map();

function isCons(w, i) {
  const c = w[i];
  if (c === 'a' || c === 'e' || c === 'i' || c === 'o' || c === 'u') return false;
  if (c === 'y') return i === 0 ? true : !isCons(w, i - 1);
  return true;
}

/** m() — the number of VC sequences in w[0..end). */
function measure(w, end) {
  let n = 0, i = 0;
  while (i < end && isCons(w, i)) i++;
  while (i < end) {
    while (i < end && !isCons(w, i)) i++;
    if (i >= end) break;
    n++;
    while (i < end && isCons(w, i)) i++;
  }
  return n;
}

function hasVowel(w, end) {
  for (let i = 0; i < end; i++) if (!isCons(w, i)) return true;
  return false;
}

function doubleCons(w, end) {
  return end >= 2 && w[end - 1] === w[end - 2] && isCons(w, end - 1);
}

/** cvc(i): consonant-vowel-consonant ending at end-1, last consonant not w, x, y. */
function cvc(w, end) {
  if (end < 3) return false;
  if (!isCons(w, end - 1) || isCons(w, end - 2) || !isCons(w, end - 3)) return false;
  const c = w[end - 1];
  return c !== 'w' && c !== 'x' && c !== 'y';
}

/** Replace suffix `s` with `r` when m(stem) > minM. Returns new word or null if suffix absent. */
function replaceIf(w, s, r, minM) {
  if (!w.endsWith(s)) return null;
  const stemLen = w.length - s.length;
  return measure(w, stemLen) > minM ? w.slice(0, stemLen) + r : w;
}

const STEP2 = [
  ['ational', 'ate'], ['tional', 'tion'], ['enci', 'ence'], ['anci', 'ance'], ['izer', 'ize'],
  ['bli', 'ble'], ['alli', 'al'], ['entli', 'ent'], ['eli', 'e'], ['ousli', 'ous'],
  ['ization', 'ize'], ['ation', 'ate'], ['ator', 'ate'], ['alism', 'al'], ['iveness', 'ive'],
  ['fulness', 'ful'], ['ousness', 'ous'], ['aliti', 'al'], ['iviti', 'ive'], ['biliti', 'ble'],
  ['logi', 'log'],
];
const STEP3 = [
  ['icate', 'ic'], ['ative', ''], ['alize', 'al'], ['iciti', 'ic'], ['ical', 'ic'], ['ful', ''], ['ness', ''],
];
const STEP4 = [
  'al', 'ance', 'ence', 'er', 'ic', 'able', 'ible', 'ant', 'ement', 'ment', 'ent',
  'ion', 'ou', 'ism', 'ate', 'iti', 'ous', 'ive', 'ize',
];

function stemUncached(w) {
  if (w.length <= 2) return w;

  // Step 1a
  if (w.endsWith('sses')) w = w.slice(0, -2);
  else if (w.endsWith('ies')) w = w.slice(0, -2);
  else if (w.endsWith('ss')) { /* keep */ }
  else if (w.endsWith('s')) w = w.slice(0, -1);

  // Step 1b
  let extra = false;
  if (w.endsWith('eed')) {
    if (measure(w, w.length - 3) > 0) w = w.slice(0, -1);
  } else if (w.endsWith('ed') && hasVowel(w, w.length - 2)) {
    w = w.slice(0, -2); extra = true;
  } else if (w.endsWith('ing') && hasVowel(w, w.length - 3)) {
    w = w.slice(0, -3); extra = true;
  }
  if (extra) {
    if (w.endsWith('at') || w.endsWith('bl') || w.endsWith('iz')) w += 'e';
    else if (doubleCons(w, w.length) && !/[lsz]$/.test(w)) w = w.slice(0, -1);
    else if (measure(w, w.length) === 1 && cvc(w, w.length)) w += 'e';
  }

  // Step 1c
  if (w.endsWith('y') && hasVowel(w, w.length - 1)) w = w.slice(0, -1) + 'i';

  // Step 2
  for (const [s, r] of STEP2) {
    if (w.endsWith(s)) { w = replaceIf(w, s, r, 0); break; }
  }
  // Step 3
  for (const [s, r] of STEP3) {
    if (w.endsWith(s)) { w = replaceIf(w, s, r, 0); break; }
  }
  // Step 4
  for (const s of STEP4) {
    if (!w.endsWith(s)) continue;
    const stemLen = w.length - s.length;
    if (measure(w, stemLen) > 1) {
      if (s === 'ion') {
        const c = w[stemLen - 1];
        if (c === 's' || c === 't') w = w.slice(0, stemLen);
      } else {
        w = w.slice(0, stemLen);
      }
    }
    break;
  }
  // Step 5a
  if (w.endsWith('e')) {
    const m = measure(w, w.length - 1);
    if (m > 1 || (m === 1 && !cvc(w, w.length - 1))) w = w.slice(0, -1);
  }
  // Step 5b
  if (measure(w, w.length) > 1 && doubleCons(w, w.length) && w.endsWith('l')) w = w.slice(0, -1);
  return w;
}

/** Stem one lowercase ASCII word. Non-ASCII words are returned unchanged. */
export function stem(word) {
  if (!/^[a-z]+$/.test(word)) return word;
  let s = cache.get(word);
  if (s === undefined) {
    s = stemUncached(word);
    if (cache.size > 200000) cache.clear();
    cache.set(word, s);
  }
  return s;
}
