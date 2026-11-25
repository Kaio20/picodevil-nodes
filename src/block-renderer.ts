import * as Blockly from "blockly";
import { blockPalette } from "./block-definitions";

class CompactConstants extends Blockly.blockRendering.ConstantProvider {
  constructor() {
    super();
    this.SMALL_PADDING = 2;
    this.MEDIUM_PADDING = 3;
    this.MEDIUM_LARGE_PADDING = 4;
    this.LARGE_PADDING = 6;
    this.MIN_BLOCK_WIDTH = 20;
    this.MIN_BLOCK_HEIGHT = 16;
    this.DUMMY_INPUT_MIN_HEIGHT = 16;
    this.DUMMY_INPUT_SHADOW_MIN_HEIGHT = 14;
    this.FIELD_BORDER_RECT_X_PADDING = 3;
    this.FIELD_BORDER_RECT_Y_PADDING = 1;
    this.FIELD_BORDER_RECT_HEIGHT = 14;
    this.FIELD_DROPDOWN_BORDER_RECT_HEIGHT = 14;
    this.FIELD_BORDER_RECT_RADIUS = 2;
    this.TAB_WIDTH = 5;
    this.TAB_HEIGHT = 9;
    this.TAB_OFFSET_FROM_TOP = 3;
    this.CORNER_RADIUS = 2;
    this.TOP_ROW_MIN_HEIGHT = 1;
    this.BOTTOM_ROW_MIN_HEIGHT = 1;
    this.NOTCH_HEIGHT = 2;
    this.NOTCH_WIDTH = 10;
    this.NOTCH_OFFSET_LEFT = 5;
    this.STATEMENT_INPUT_NOTCH_OFFSET = 3;
    this.STATEMENT_INPUT_PADDING_LEFT = 4;
    this.STATEMENT_BOTTOM_SPACER = 2;
    this.BETWEEN_STATEMENT_PADDING_Y = 2;
    this.TOP_ROW_PRECEDES_STATEMENT_MIN_HEIGHT = 2;
    this.BOTTOM_ROW_AFTER_STATEMENT_MIN_HEIGHT = 2;
    this.EMPTY_STATEMENT_INPUT_HEIGHT = 16;
    this.EMPTY_INLINE_INPUT_HEIGHT = 14;
  }
}

class CompactDrawer extends Blockly.blockRendering.Drawer {
  override draw() {
    super.draw();
    const block = this.block_;
    const style = block.getStyleName() as keyof typeof blockPalette;
    block.getSvgRoot().style.setProperty("--bd-accent", blockPalette[style] ?? "#77828c");

    // Keep Blockly's connection geometry. When a stack is present, paint
    // only its header and leading rail instead of enclosing it in a large C.
    const stackRow = this.info_.rows.find(row => row.hasStatement);
    const hasStack = block.getInputTargetBlock("STEPS") !== null;
    const path = block.pathObject.svgPath;
    if (stackRow && hasStack) {
      const head = `${stackRow.yPos + 1}px`;
      const rail = `${Math.min(7, Math.max(3, stackRow.statementEdge))}px`;
      path.style.clipPath = `polygon(0 0, 100% 0, 100% ${head}, ${rail} ${head}, ${rail} 100%, 0 100%)`;
    } else {
      path.style.removeProperty("clip-path");
    }
  }
}

class CompactRenderer extends Blockly.thrasos.Renderer {
  protected override makeConstants_() { return new CompactConstants(); }

  protected override makeDrawer_(block: Blockly.BlockSvg, info: Blockly.blockRendering.RenderInfo) {
    return new CompactDrawer(block, info);
  }
}

export const compactRenderer = "picodevil_compact";
Blockly.blockRendering.register(compactRenderer, CompactRenderer);
