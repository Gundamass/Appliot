export interface EvidenceBox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

interface GroundingBlock {
  text: string;
  boxes: EvidenceBox[];
}

export interface EvidenceGrounding {
  match: "exact" | "page";
  coordinateSpace: 1000;
  boxes: EvidenceBox[];
}

const GROUNDING_BLOCK = /<\|ref\|>[^<]*<\|\/ref\|><\|det\|>(\[[^]*?\])<\|\/det\|>\s*([^]*?)(?=<\|ref\|>|$)/g;

export function parseGroundingBlocks(content: string): GroundingBlock[] {
  const blocks: GroundingBlock[] = [];
  for (const match of content.matchAll(GROUNDING_BLOCK)) {
    const boxes = parseBoxes(match[1] ?? "");
    const text = (match[2] ?? "").trim();
    if (boxes.length > 0 && text !== "") blocks.push({ text, boxes });
  }
  return blocks;
}

export function findEvidenceGrounding(content: string, quote: string): EvidenceGrounding {
  const target = normalizeEvidenceText(quote);
  if (target !== "") {
    for (const block of parseGroundingBlocks(content)) {
      const candidate = normalizeEvidenceText(block.text);
      if (candidate.includes(target) || target.includes(candidate)) {
        return { match: "exact", coordinateSpace: 1000, boxes: block.boxes };
      }
    }
  }
  return { match: "page", coordinateSpace: 1000, boxes: [] };
}

function parseBoxes(value: string): EvidenceBox[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((box) => {
      if (
        !Array.isArray(box)
        || box.length !== 4
        || !box.every((coordinate) => Number.isFinite(coordinate))
      ) return [];
      const [x1, y1, x2, y2] = box as [number, number, number, number];
      if (x1 < 0 || y1 < 0 || x2 > 1000 || y2 > 1000 || x1 >= x2 || y1 >= y2) return [];
      return [{ x1, y1, x2, y2 }];
    });
  } catch {
    return [];
  }
}

function normalizeEvidenceText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/<\|[^|]+\|>/g, "")
    .replace(/^[#>*•\-\s]+/gm, "")
    .replace(/[\s_]+/g, "")
    .toLocaleLowerCase("zh-CN");
}
