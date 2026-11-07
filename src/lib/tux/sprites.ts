// Original 16 × 16 pixel artwork. All frames share the same transparent canvas.
const body = [
  "................", "......kkkk......", ".....kkkkkk.....", "....kkwkkwkk....",
  "....kkwkkwkk....", "....kkoyyokk....", "....kkkyykkk....", "...kkwwwwwwkk...",
  "..kkwwwwwwwwkk..", "..kkwwwwwwwwkk..", ".kkkwwwwwwwwkkk.", "..kkwwwwwwwwkk..",
  "...kkwwwwwwkk...", "....kkkkkkkk....", "...yyy....yyy...", "..yyyy....yyyy..",
];
function frame(changes: Record<number, string>): string[] { return body.map((row, i) => changes[i] ?? row); }
export const sprites = {
  stand: body,
  blink: frame({ 3: "....kkkkkkkk....", 4: "....kk-kk-kk...." }),
  walk1: frame({ 14: "..yyyy....yy....", 15: "...yyy.....yyyy." }),
  walk2: frame({ 14: "....yy....yyyy..", 15: ".yyyy.....yyy..." }),
  fall: frame({ 8: "kkkwwwwwwwwwwkkk", 9: ".kkwwwwwwwwwwkk." }),
  dig: frame({ 12: "...kkwwwwwwkkyy.", 13: "....kkkkkkkkyyy." }),
  // Scooping cycle: flippers raised, swung down and out, then pulled in while crouching.
  digUp: frame({ 5: "..k.kkoyyokk.k..", 6: "..kkkkkyykkkkk..", 7: "...kkwwwwwwkk...", 10: "...kwwwwwwwwk...", 11: "...kwwwwwwwwk..." }),
  digDown: frame({ 9: "..kwwwwwwwwwwk..", 10: "kkkkwwwwwwwwkkkk", 11: "k.kkwwwwwwwwkk.k", 12: "...kkwwwwwwkk..." }),
  digCrouch: frame({ 1: "................", 2: "......kkkk......", 3: ".....kkkkkk.....", 4: "....kkwkkwkk....", 5: "....kkoyyokk....", 13: "...kkkkkkkkkk...", 14: "..yyyy....yyyy..", 15: "..yyyy....yyyy.." }),
  wave: frame({ 6: ".kk.kkkyykkk....", 7: ".kkkkwwwwwwkk..." }),
};
export const palette: Record<string, string> = { k: "#182735", w: "#f1f5ee", y: "#ffbe45", o: "#16212b", "-": "#182735" };
