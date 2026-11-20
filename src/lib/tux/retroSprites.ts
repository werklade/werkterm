import { body, editRows, profile, type Prop } from "./sprites";
// Original pixel art for the three retro designs (issue #25): Tux frames (16 x 16) and props with their own palettes.
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
  /** Replaces stand, sideA and sideB of the ambient Tux; everything else comes from sprites.ts. */
  base: { stand: string[]; sideA: string[]; sideB: string[] };
  /** Tux frames used by the actions, all 16 x 16. */
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
const lemmingePalette: Raster = { k: "#4a5d7a", w: "#f1f5ee", y: "#ffbe45", o: "#10161d", "-": "#4a5d7a", g: "#7ccf3a", G: "#4f9a22", b: "#3b6fd8", p: "#8a5a2b", s: "#c8cdd2", P: "#b57a3d", l: "#ffe9a8" };
const lemminge: RetroLook = {
  palette: lemmingePalette,
  base: { stand: lemmingeStand, sideA: lemmingeWalkA, sideB: lemmingeWalkB },
  tux: {
    stand: lemmingeStand, sideA: lemmingeWalkA, sideB: lemmingeWalkB,
    stopA: editRows(lemmingeStand, [[8, 0, "kkkk"], [8, 12, "kkkk"], [9, 0, "kkkk"], [9, 12, "kkkk"]]),
    stopB: editRows(lemmingeStand, [[7, 0, "kkkk"], [7, 12, "kkkk"], [8, 0, "kkkk"], [8, 12, "kkkk"]]),
    digFA: editRows(lemmingeStand, [[10, 0, "kkkk"], [10, 12, "kkkk"], [11, 0, "k"], [11, 15, "k"]]),
    digFB: editRows(lemmingeStand, armsUp),
    hang: editRows(lemmingeStand, [...armsUp, [14, 0, "....yy....yy...."], [15, 0, "....yy....yy...."]]),
    buildA: editRows(lemmingeWalkA, [[7, 12, "pppp"], [8, 13, "ppp"]]),
    buildB: editRows(lemmingeWalkB, [[10, 13, "ppp"], [11, 13, "ppp"]]),
  },
  props: {
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
const robot = [
  "................", ".....yyyyyy.....", "....yyyyyyyy....", "....dddddddd....", "...dmmmmmmmmd...", "...dmrrmmrrmd...", "...dmmmmmmmmd...", "...dmmoooommd...",
  "..dddddddddddd..", ".dmmmmmmmmmmmmd.", ".dmmlmmmmmmlmmd.", ".dmmmmmyymmmmmd.", ".dmmmmmmmmmmmmd.", "..dddddddddddd..", "...dd......dd...", "..ddd......ddd..",
];
const robotPalette: Raster = { d: "#3a3f5c", m: "#8c93b3", l: "#c9ceea", r: "#ff4d6d", y: "#ffd23f", o: "#05050a" };
const robotLift: [number, number, string][] = [2, 3, 4, 5, 6, 7].flatMap(y => [[y, 1, "dm"], [y, 13, "md"]] as [number, number, string][]);
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
  base: { stand: geruestStand, sideA: geruestWalkA, sideB: geruestWalkB },
  tux: {
    stand: geruestStand, sideA: geruestWalkA, sideB: geruestWalkB,
    climbA: frame({ 5: "k...kkoyyokk....", 6: "kk..kkkyykkk....", 7: ".kkkkwwwwwwkk...", 14: "...yyy....yy....", 15: "..yyyy....yyy..." }, geruestStand),
    climbB: frame({ 5: "....kkoyyokk...k", 6: "....kkkyykkk..kk", 7: "...kkwwwwwwkkkk.", 14: "....yy....yyy...", 15: "...yyy....yyyy.." }, geruestStand),
    jumpG: editRows(geruestStand, [[8, 0, "kkkk"], [8, 12, "kkkk"], [9, 0, "kkkk"], [9, 12, "kkkk"], [14, 0, "....yyyyyyyy...."], [15, 0, "................"]]),
    cheer: editRows(geruestStand, armsUp),
  },
  props: {
    robot: [robot, editRows(robot, robotLift), editRows(robot, [[6, 0, "dm"], [7, 0, "dm"], [8, 0, "dd"], [5, 13, "md"], [6, 13, "md"]])].map(rows => prop(rows, robotPalette)),
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
const huepfer: RetroLook = {
  palette: huepferPalette,
  base: { stand: huepferStand, sideA: huepferWalkA, sideB: huepferWalkB },
  tux: {
    stand: huepferStand, sideA: huepferWalkA, sideB: huepferWalkB,
    jump: upOne(frame({ 5: "k...kkoyyokk...k", 6: "kk..kkkyykkk..kk", 7: ".kkkkwwwwwwkkkk.", 14: "....yy....yy....", 15: "....yy....yy...." }, huepferStand)),
    eatA: editRows(huepferWalkA, [[5, 11, "..."], [6, 11, "yy"]]),
    eatB: editRows(huepferWalkB, [[3, 9, "k-"]]),
  },
  props: {
    block: [block, block.map(row => row.replace(/y/g, "g")), ["dddddddd", "dlEEEEld", "dEEEEEEd", "dEEEEEEd", "dEEEEEEd", "dEEEEEEd", "dlEEEEld", "dddddddd"]].map(rows => prop(rows, propPalette)),
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
