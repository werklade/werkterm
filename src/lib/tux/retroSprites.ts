import { body, editRows, profile, type Prop } from "./sprites";
// Original pixel art for the three retro designs (issue #25): Tux frames (16 x 16) and props with their own palettes.
// Each design draws every state of its Tux itself; the normal sprites of sprites.ts are not used in retro designs.
export type RetroId = "lemminge" | "geruest" | "huepfer";
export type Raster = Record<string, string>;
/** Edits as row -> replacement text (whole row, 16 characters). */
const frame = (rows: Record<number, string>, base = body) => base.map((row, i) => rows[i] ?? row);
const feetA = [".....yyy..yy....", "....yyyy...yyy.."], feetB = ["......yy.yyy....", ".....yyy.yyyy..."];
const side = (rows: Record<number, string>, feet: string[]) => [...profile.map((row, i) => rows[i] ?? row), ...feet];
const upOne = (rows: string[]) => [...rows.slice(1), "................"];
const armsUp: [number, number, string][] = [[5, 0, "k"], [5, 15, "k"], [6, 0, "kk"], [6, 14, "kk"], [7, 1, "kkkk"], [7, 11, "kkkk"]];
const prop = (rows: string[], palette: Raster): Prop => ({ rows, palette });

export interface RetroLook {
  /** Sprite palette; `k` (and `-`) is the fixed body colour of this design's Tux. */
  palette: Raster;
  /** Tux frames, all 16 x 16. */
  tux: Record<string, string[]>;
  /** Props, any size, each with its own palette. Animated props are lists. */
  props: Record<string, Prop[]>;
}

// ---------- Retro Lemminge ----------
const lemmingeStand = frame({ 0: "......gggg......", 1: ".....gGGGGg.....", 11: "..kkbbbbbbbbkk..", 12: "...kkbbbbbbkk..." });
const lemmingeSide = { 0: "........gg......", 1: "......gGGg......", 11: "..kkkkkbbbbbb...", 12: "...kkkkbbbbbb...", 13: "....kkkkbbbb...." };
const lemmingeWalkA = side(lemmingeSide, feetA), lemmingeWalkB = side(lemmingeSide, feetB);
const doorFrame = (kind: 0 | 1 | 2) => {
  const rows = [".ssssssss.", "ssppppppss"];
  for (let y = 2; y < 13; y++) rows.push(kind === 0 ? (y === 7 ? "sppppppyps" : "spppppppps") : kind === 1 ? (y === 7 ? "spyoooooos" : "sppoooooos") : (y >= 10 ? "sollllllos" : "soooooooos"));
  rows.push("ssssssssss");
  return rows;
};
const lemmingePalette: Raster = { k: "#4a5d7a", w: "#f1f5ee", y: "#ffbe45", o: "#10161d", "-": "#4a5d7a", g: "#7ccf3a", G: "#4f9a22", b: "#3b6fd8", p: "#8a5a2b", s: "#c8cdd2", P: "#b57a3d", l: "#ffe9a8", n: "#6b4a2a", N: "#43301c", S: "#5f6b78", t: "#98a3ae" };
const lemminge: RetroLook = {
  palette: lemmingePalette,
  tux: {
    stand: lemmingeStand, sideA: lemmingeWalkA, sideB: lemmingeWalkB,
    stopA: editRows(lemmingeStand, [[8, 0, "kkkk"], [8, 12, "kkkk"], [9, 0, "kkkk"], [9, 12, "kkkk"]]),
    stopB: editRows(lemmingeStand, [[7, 0, "kkkk"], [7, 12, "kkkk"], [8, 0, "kkkk"], [8, 12, "kkkk"]]),
    hang: editRows(lemmingeStand, [...armsUp, [14, 0, "....yy....yy...."], [15, 0, "....yy....yy...."]]),
    buildA: editRows(lemmingeWalkA, [[7, 12, "pppp"], [8, 13, "ppp"]]),
    buildB: editRows(lemmingeWalkB, [[10, 13, "ppp"], [11, 13, "ppp"]]),
    // Hand digging: the hands scratch at the ground in turns.
    digA: editRows(lemmingeStand, [[11, 1, "k"], [12, 1, "k"], [13, 0, "kk"], [14, 0, "kkk"], [15, 0, "kk"], [10, 15, "k"], [11, 14, "k"]]),
    digB: editRows(lemmingeStand, [[10, 0, "k"], [11, 1, "k"], [11, 14, "k"], [12, 14, "k"], [13, 14, "kk"], [14, 13, "kkk"], [15, 14, "kk"]]),
    // Side view, hands first: tunnel through a word or dig diagonally downwards.
    tunA: editRows(lemmingeWalkA, [[9, 13, "kkk"], [10, 13, "kk"]]),
    tunB: editRows(lemmingeWalkB, [[10, 13, "kkk"], [11, 13, "kk"]]),
    /** Shoulders up: steel in the way, the Tux gives up and turns round. */
    shrug: editRows(lemmingeStand, [[6, 0, "kk"], [6, 14, "kk"], [7, 0, "kkkk"], [7, 12, "kkkk"], [8, 0, "kkk"], [8, 13, "kkk"]]),
    climbA: editRows(lemmingeStand, [[5, 0, "k"], [6, 0, "kk"], [7, 1, "kkkk"]]),
    climbB: editRows(lemmingeStand, [[5, 15, "k"], [6, 14, "kk"], [7, 11, "kkkk"]]),
    squash: ["................", "................", "................", "................", "................", "................", "................", "................", "................", "................", "......gggg......", "....kkkkkkkk....", "..kkkwwkkwwkkk..", ".kkkbbbbbbbbkkk.", "kkkkbbbbbbbbkkkk", ".yyy........yyy."],
    plopp: ["................", "................", "................", "................", "......l..l......", "...w........w...", "..l....ww....l..", "......wllw......", ".w...wl..lw...w.", "......wllw......", "..l....ww....l..", "...w........w...", "......l..l......", "................", "................", "................"],
  },
  props: {
    badge: [prop([".wwwww.", "wgwgwgw", "...y...", "...y...", "..yy..."], lemmingePalette)],
    /** Climber ability: blue ring. */
    badgeClimb: [prop([".bbbbb.", "b.....b", "b..y..b", ".bbbbb.", "...y..."], lemmingePalette)],
    /** Cell tiles (8 x 8, drawn at cell size): a clod of soil and a steel plate. */
    earth: [prop(["gGgggGgg", "nnnnnnnn", "nNnnPnnn", "nnnnnnNn", "nnPnnnnn", "nnnnNnnn", "NnnnnnPn", "nNNnnNNn"], lemmingePalette)],
    steel: [prop(["SSSSSSSS", "SwttttwS", "StttttsS", "StttttsS", "StttttsS", "StttttsS", "SwttttwS", "SSSSSSSS"], lemmingePalette)],
    hatchClosed: [prop(["ssssssssssssssss", "s" + "p".repeat(14) + "s", "s" + "p".repeat(14) + "s", "ssssssssssssssss"], lemmingePalette)],
    hatchOpen: [prop(["ssssssssssssssss", "s" + "o".repeat(14) + "s", "s" + "o".repeat(14) + "s", "ssssssssssssssss"], lemmingePalette)],
    canopy: [prop(["....gggggggg....", "..gggwwggwwggg..", ".gggwwwggwwwggg.", "gggwwwwggwwwwggg", "g.g..g.gg.g..g.g", ".g...g....g...g."], lemmingePalette)],
    step: [prop(["PPPPPPPP", "pppppppp"], lemmingePalette)],
    door: [doorFrame(0), doorFrame(1), doorFrame(2)].map(rows => prop(rows, lemmingePalette)),
  },
};

// ---------- Retro Gerüst ----------
const geruestStand = frame({ 1: "......hhhh......", 2: "....hhhhhhhh....", 8: "..kkwrwwwwrwkk..", 9: "..kkwrwwwwrwkk..", 10: ".kkkrrrrrrrrkkk.", 11: "..kkrrrrrrrrkk..", 12: "...kkrrrrrrkk..." });
const geruestSide = { 1: "......hhhh......", 2: ".....hhhhhh.....", 3: "....kkkkkwokhh..", 9: "..kkkkkwrwwww...", 10: "..kkkkkrrrrrr...", 11: "..kkkkkrrrrrr...", 12: "...kkkkrrrrrr...", 13: "....kkkkrrrr...." };
const geruestWalkA = side(geruestSide, feetA), geruestWalkB = side(geruestSide, feetB);
const geruestPalette: Raster = { k: "#4b4f8a", w: "#f4efe6", y: "#ffb02e", o: "#05050a", "-": "#4b4f8a", h: "#ffd23f", H: "#fff0a0", r: "#e0245e", c: "#19e6ff" };
const robotPalette: Raster = { d: "#3a3f5c", m: "#8c93b3", l: "#c9ceea", r: "#ff4d6d", y: "#ffd23f", Y: "#fff0a0", o: "#05050a" };
/** The 24 x 24 robot in four frames; arms and mouth change with the pose. */
function robotFrame(kind: "idle" | "lift" | "throw" | "stomp"): string[] {
  const g = Array.from({ length: 24 }, () => Array<string>(24).fill("."));
  const R = (x: number, y: number, w: number, h: number, c: string) => { for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) if (g[j] && i >= 0 && i < 24) g[j][i] = c; };
  const D = (x: number, y: number, c: string) => R(x, y, 1, 1, c);
  const up = kind === "lift" || kind === "stomp";
  if (up) { R(0, 7, 3, 9, "d"); R(1, 8, 1, 7, "m"); R(0, 5, 3, 2, "y"); R(21, 7, 3, 9, "d"); R(22, 8, 1, 7, "m"); R(21, 5, 3, 2, "y"); }
  else if (kind === "throw") { R(0, 13, 3, 4, "d"); R(0, 17, 3, 2, "y"); R(21, 7, 3, 9, "d"); R(22, 8, 1, 7, "m"); R(21, 5, 3, 2, "y"); }
  else { R(0, 15, 3, 7, "d"); R(1, 16, 1, 5, "m"); R(0, 22, 3, 2, "y"); R(21, 15, 3, 7, "d"); R(22, 16, 1, 5, "m"); R(21, 22, 3, 2, "y"); }
  R(11, 0, 2, 2, "r"); R(11, 2, 2, 2, "d");
  R(7, 4, 10, 1, "y"); R(5, 5, 14, 2, "y"); R(3, 7, 18, 1, "y"); D(8, 5, "Y"); D(9, 5, "Y");
  R(5, 8, 14, 7, "d"); R(6, 9, 12, 5, "m"); R(7, 10, 3, 2, "r"); R(14, 10, 3, 2, "r");
  D(7, 9, "o"); D(8, 9, "o"); D(9, 10, "o"); D(16, 9, "o"); D(15, 9, "o"); D(14, 10, "o");
  if (kind === "stomp") R(8, 12, 8, 2, "o"); else { R(9, 12, 6, 1, "o"); D(8, 13, "o"); D(15, 13, "o"); }
  R(3, 15, 18, 6, "d"); R(4, 16, 16, 4, "m"); R(4, 16, 16, 1, "l"); R(9, 17, 6, 2, "y"); D(6, 18, "r"); D(17, 18, "r");
  R(3, 21, 7, 3, "d"); R(14, 21, 7, 3, "d"); R(10, 21, 4, 2, "d"); D(5, 22, "m"); D(7, 22, "m"); D(16, 22, "m"); D(18, 22, "m");
  return g.map(row => row.join(""));
}
const barrelPalette: Raster = { d: "#5a2d12", B: "#c8641e", y: "#ffd23f", l: "#ffe0a0" };
const flagFrame = (phase: number) => {
  const base = [9, 8, 6, 4, 2];
  return Array.from({ length: 16 }, (_, y) => {
    const row = Array<string>(16).fill(".");
    row[3] = "w";
    if (y >= 1 && y <= 5) {
      const width = Math.max(1, Math.min(11, base[y - 1] + (y >= 3 ? Math.round(Math.sin(phase + y)) : 0)));
      for (let i = 0; i < width; i++) row[4 + i] = y <= 2 ? "h" : "r";
    }
    return row.join("");
  });
};
const geruest: RetroLook = {
  palette: geruestPalette,
  tux: {
    stand: geruestStand, sideA: geruestWalkA, sideB: geruestWalkB,
    climbA: frame({ 5: "k...kkoyyokk....", 6: "kk..kkkyykkk....", 7: ".kkkkwwwwwwkk...", 14: "...yyy....yy....", 15: "..yyyy....yyy..." }, geruestStand),
    climbB: frame({ 5: "....kkoyyokk...k", 6: "....kkkyykkk..kk", 7: "...kkwwwwwwkkkk.", 14: "....yy....yyy...", 15: "...yyy....yyyy.." }, geruestStand),
    jumpG: editRows(geruestStand, [[8, 0, "kkkk"], [8, 12, "kkkk"], [9, 0, "kkkk"], [9, 12, "kkkk"], [14, 0, "....yyyyyyyy...."], [15, 0, "................"]]),
    cheer: editRows(geruestStand, armsUp),
    hit: editRows(geruestStand, [...armsUp, [3, 0, "....kkokkokk...."]]),
  },
  props: {
    robot: (["idle", "lift", "throw", "stomp"] as const).map(kind => prop(robotFrame(kind), robotPalette)),
    barrel: [
      [".dddddd.", "dBBBBBBd", "dyyyyyyd", "dBlBBBBd", "dBBBBBBd", "dyyyyyyd", "dBBBBBBd", ".dddddd."],
      [".dddddd.", "dBBBBBBd", "dyyyyyyd", "dBBBBBBd", "dBBBBlBd", "dyyyyyyd", "dBBBBBBd", ".dddddd."],
    ].map(rows => prop(rows, barrelPalette)),
    flag: [0, 2.1, 4.2].map(phase => prop(flagFrame(phase), geruestPalette)),
  },
};

// ---------- Retro Hüpfer ----------
const huepferStand = frame({ 1: "......rwwr......", 2: "....rrrrrrrr....", 8: "..kkwbwwwwbwkk..", 9: "..kkwbwwwwbwkk..", 10: ".kkkbybbbbybkkk.", 11: "..kkbbbbbbbbkk..", 12: "...kkbbbbbbkk..." });
const huepferSide = { 1: "......rrrr......", 2: ".....rrrrrr.....", 3: "....kkkkkwokrr..", 9: "..kkkkkwbwwww...", 10: "..kkkkkbbbbbb...", 11: "..kkkkkbbbbbb...", 12: "...kkkkbbbbbb...", 13: "....kkkkbbbb...." };
const huepferWalkA = side(huepferSide, feetA), huepferWalkB = side(huepferSide, feetB);
const huepferPalette: Raster = { k: "#46589f", w: "#f1f5ee", y: "#ffbe45", o: "#0a1020", "-": "#46589f", r: "#e8412e", b: "#2f6bd8", u: "#ffd23f" };
const propPalette: Raster = { d: "#5a2a0c", y: "#fcc419", g: "#fff0a0", G: "#e0a800", E: "#9a5f2a", l: "#c68a4e", B: "#b5522a", f: "#ff8a5b", F: "#ffd0b0", e: "#0a1020", w: "#f1f5ee", c: "#9fd8ff", s: "#5aa0d8" };
const block = ["dddddddd", "dyyyyyyd", "dyyddyyd", "dyyyydyd", "dyyydyyd", "dyyyyyyd", "dyyydyyd", "dddddddd"];
const star = ["...yy...", "...yy...", "yyyyyyyy", ".yyggyy.", "..yggy..", "..yyyy..", ".yy..yy.", "yy....yy"];
const huepferSoar = editRows(huepferStand, [[8, 0, "kkkk"], [8, 12, "kkkk"], [9, 0, "kkkk"], [9, 12, "kkkk"], [14, 0, "....yyyyyyyy...."], [15, 0, "................"]]);
const huepfer: RetroLook = {
  palette: huepferPalette,
  tux: {
    stand: huepferStand, sideA: huepferWalkA, sideB: huepferWalkB,
    jump: upOne(frame({ 5: "k...kkoyyokk...k", 6: "kk..kkkyykkk..kk", 7: ".kkkkwwwwwwkkkk.", 14: "....yy....yy....", 15: "....yy....yy...." }, huepferStand)),
    eatA: editRows(huepferWalkA, [[5, 11, "..."], [6, 11, "yy"]]),
    eatB: editRows(huepferWalkB, [[3, 9, "k-"]]),
    crouch: [...Array<string>(4).fill("................"), ...[1, 2, 3, 4, 5, 6, 7, 8, 11, 12, 14, 15].map(i => huepferStand[i])],
    slam: editRows(huepferStand, [[14, 0, "....yyyyyyyy...."], [15, 0, "................"], [3, 0, "....kkokkokk...."]]),
    fallA: editRows(huepferStand, [...armsUp, [14, 0, "..yyy.....yy...."], [15, 0, ".yyy......yyy..."]]),
    fallB: editRows(huepferStand, [...armsUp, [14, 0, "....yy....yyy..."], [15, 0, "...yyy....yyyy.."]]),
    soar: huepferSoar,
  },
  props: {
    block: [block, block.map(row => row.replace(/y/g, "g")), ["dddddddd", "dlEEEEld", "dEEEEEEd", "dEEEEEEd", "dEEEEEEd", "dEEEEEEd", "dlEEEEld", "dddddddd"]].map(rows => prop(rows, propPalette)),
    /** Cell tile of the brick rows: 9 x 16, one tile pixel per virtual pixel (no stretched 8 x 8 brick). */
    brickTile: [prop(["fBBBdfBBB", "BBBBdBBBB", "BBBBdBBBB", "ddddddddd", "dfBBBBBBB", "dBBBBBBBB", "dBBBBBBBB", "ddddddddd", "fBBBdfBBB", "BBBBdBBBB", "BBBBdBBBB", "ddddddddd", "dfBBBBBBB", "dBBBBBBBB", "dBBBBBBBB", "ddddddddd"], propPalette)],
    brick: [prop(["BBBBdBBB", "BBBBdBBB", "dddddddd", "BBdBBBBd", "BBdBBBBd", "dddddddd", "BBBBdBBB", "BBBBdBBB"], propPalette)],
    coin: [
      ["..dddd..", ".dyyyyd.", ".dygyyd.", ".dygyyd.", ".dyyyyd.", ".dyyyyd.", ".dyyyyd.", "..dddd.."],
      ["..dddd..", "..dyyd..", "..dgyd..", "..dgyd..", "..dyyd..", "..dyyd..", "..dyyd..", "..dddd.."],
      ["...dd...", "...dG...", "...dG...", "...dG...", "...dG...", "...dG...", "...dG...", "...dd..."],
    ].map(rows => prop(rows, propPalette)),
    fish: [
      ["........", "..ffff.f", ".fefffff", "fffffFFf", ".fffffff", "..ffff.f", "........", "........"],
      ["........", "..ffff..", ".fefffff", "fffffFFf", ".fffffff", "..ffff..", "........", "........"],
    ].map(rows => prop(rows, propPalette)),
    star: [star, star.map(row => row.replace(/g/g, "w").replace(/y/g, "g"))].map(rows => prop(rows, propPalette)),
    feather: [prop(["......ww", ".....www", "....wwws", "...wwwsc", "..wwwscc", ".wwwscc.", "wwsc....", "ws......"], propPalette)],
  },
};

export const retroLooks: Record<RetroId, RetroLook> = { lemminge, geruest, huepfer };
/** Design names (ids in builtInDesigns) of the retro designs. */
export const retroDesignNames: Record<RetroId, string> = { lemminge: "Retro Lemminge", geruest: "Retro Gerüst", huepfer: "Retro Hüpfer" };
export function retroIdForDesign(name: string): RetroId | null {
  return (Object.keys(retroDesignNames) as RetroId[]).find(id => retroDesignNames[id] === name) ?? null;
}
