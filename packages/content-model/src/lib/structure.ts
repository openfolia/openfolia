import type { Block, Item, Table } from './blocks.js';
import { tableTooLarge } from './table-limits.js';

/** AsciiDoc supports five levels of list markers (`*` to `*****`) and section levels `==` to `======`. */
export const MAX_LIST_DEPTH = 5;
export const MAX_SECTION_DEPTH = 5;

/** The heading levels the editor offers when the configuration names none. */
export const DEFAULT_MAX_HEADING_LEVEL = 3;

interface Context {
  /** Sections may only appear at module level or directly inside another section. */
  sectionsAllowed: boolean;
  sectionDepth: number;
  /** Lists nested through list items. Delimited blocks and table cells start again at 0. */
  listDepth: number;
  inTableCell: boolean;
}

/**
 * Structural rules that every module must meet so it can be stored as
 * AsciiDoc and read back unchanged. Returns one message per problem.
 */
export function checkStructure(blocks: readonly Block[]): string[] {
  const problems: string[] = [];
  checkBlocks(blocks, {
    sectionsAllowed: true,
    sectionDepth: 0,
    listDepth: 0,
    inTableCell: false,
  });
  return problems;

  function checkBlocks(list: readonly Block[], ctx: Context): void {
    let sawSection = false;
    for (const block of list) {
      if (block.type === 'section') {
        sawSection = true;
        if (!ctx.sectionsAllowed) {
          problems.push(
            `section "${block.id}" must be at module level or inside another section`,
          );
        } else if (ctx.sectionDepth >= MAX_SECTION_DEPTH) {
          problems.push(
            `section "${block.id}" is nested deeper than ${MAX_SECTION_DEPTH} levels`,
          );
        }
      } else if (sawSection) {
        problems.push(
          `block "${block.id}" follows a section at the same level; move it into the section`,
        );
      }
      checkBlock(block, ctx);
    }
  }

  function checkBlock(block: Block, ctx: Context): void {
    const delimited: Context = {
      sectionsAllowed: false,
      sectionDepth: 0,
      listDepth: 0,
      inTableCell: ctx.inTableCell,
    };
    switch (block.type) {
      case 'section':
        checkBlocks(block.blocks, {
          ...ctx,
          sectionDepth: ctx.sectionDepth + 1,
          sectionsAllowed: true,
        });
        return;
      case 'list':
        checkItems(block.id, block.items, ctx);
        return;
      case 'procedure':
        checkItems(block.id, block.steps, ctx);
        return;
      case 'safety':
      case 'admonition':
      case 'faq':
      case 'variant':
        checkBlocks(block.blocks, delimited);
        return;
      case 'table':
        // A table past the caps (#686) is the schema's to refuse (`TableSchema`,
        // `table-too-large`): not a row of it is read here, as its grid costs a place per row
        // and column.
        if (tableTooLarge(block.columns.length, block.rows.length)) return;
        if (ctx.inTableCell)
          problems.push(
            `table "${block.id}" is inside a table cell; nested tables are not supported`,
          );
        checkTable(block);
        for (const row of block.rows) {
          for (const cell of row.cells) {
            checkBlocks(cell.blocks, { ...delimited, inTableCell: true });
          }
        }
        return;
      case 'pageBreak':
        // A page can break only between the blocks of a module or a section:
        // not in a list, a table, a notice or a variant block (Typst refuses
        // a page break inside a container).
        if (!ctx.sectionsAllowed)
          problems.push(
            `page break "${block.id}" must be at module level or directly inside a section`,
          );
        return;
      case 'paragraph':
      case 'image':
      case 'attachment':
      case 'moduleRef':
      case 'literal':
      case 'passthrough':
        return;
      default:
        block satisfies never;
    }
  }

  function checkItems(id: string, items: readonly Item[], ctx: Context): void {
    const depth = ctx.listDepth + 1;
    if (depth > MAX_LIST_DEPTH) {
      problems.push(
        `list "${id}" is nested deeper than ${MAX_LIST_DEPTH} levels`,
      );
    }
    for (const item of items) {
      checkBlocks(item.blocks, {
        ...ctx,
        sectionsAllowed: false,
        listDepth: depth,
      });
    }
  }

  function checkTable(table: Table): void {
    const where = `table "${table.id}"`;
    const header = table.rows[0];
    if (table.header && header) {
      const simple = header.cells.every(
        (cell) =>
          (cell.blocks.length === 0 ||
            (cell.blocks.length === 1 &&
              cell.blocks[0]?.type === 'paragraph')) &&
          (cell.rowspan ?? 1) === 1,
      );
      if (!simple)
        problems.push(
          `${where}: header cells must each hold one paragraph (or nothing) and span one row`,
        );
    }

    // Every row must cover exactly the table's columns, counting rowspans from rows above.
    const width = table.columns.length;
    const carried = new Array<number>(width).fill(0);
    table.rows.forEach((row, r) => {
      const rowNumber = r + 1;
      const occupied = carried.map((n) => n > 0);
      let col = 0;
      let overflowed = false;
      cells: for (const [i, cell] of row.cells.entries()) {
        const cellName = `row ${rowNumber}, cell ${i + 1}`;
        while (col < width && occupied[col]) col++;
        const colspan = cell.colspan ?? 1;
        const rowspan = cell.rowspan ?? 1;
        if (col + colspan > width) {
          problems.push(
            `${where}: row ${rowNumber} has more cells than the table's ${width} columns`,
          );
          overflowed = true;
          break;
        }
        if (r + rowspan > table.rows.length) {
          problems.push(
            `${where}: ${cellName} spans ${rowspan} rows but only ${table.rows.length - r} remain`,
          );
        }
        for (let c = col; c < col + colspan; c++) {
          if (occupied[c]) {
            problems.push(
              `${where}: ${cellName} overlaps a cell spanning down from an earlier row`,
            );
            overflowed = true;
            break cells;
          }
          occupied[c] = true;
          carried[c] = Math.max(carried[c] ?? 0, rowspan);
        }
        col += colspan;
      }
      const filled = occupied.filter(Boolean).length;
      if (filled < width && !overflowed) {
        problems.push(
          `${where}: row ${rowNumber} covers ${filled} of ${width} columns`,
        );
      }
      for (let c = 0; c < width; c++)
        carried[c] = Math.max(0, (carried[c] ?? 0) - 1);
    });
  }
}
