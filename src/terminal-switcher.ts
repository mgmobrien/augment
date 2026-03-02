import { App, FuzzySuggestModal, WorkspaceLeaf } from "obsidian";
import { TerminalView, VIEW_TYPE_TERMINAL } from "./terminal-view";

export class TerminalSwitcherModal extends FuzzySuggestModal<WorkspaceLeaf> {
  constructor(app: App) {
    super(app);
    this.setPlaceholder("Switch to terminal...");
  }

  getItems(): WorkspaceLeaf[] {
    return this.app.workspace.getLeavesOfType(VIEW_TYPE_TERMINAL);
  }

  getItemText(leaf: WorkspaceLeaf): string {
    const view = leaf.view as TerminalView;
    return this.getLeafTerminalName(leaf, view);
  }

  renderSuggestion(leaf: { item: WorkspaceLeaf; match: any }, el: HTMLElement): void {
    const view = leaf.item.view as TerminalView;
    const wrapper = el.createDiv({ cls: "augment-ts-suggestion" });

    // Status dot
    const dot = wrapper.createDiv({ cls: "augment-ts-dot" });
    const status = view.getStatus();
    dot.addClass(status);

    // Name
    wrapper.createSpan({ cls: "augment-ts-name", text: this.getLeafTerminalName(leaf.item, view) });
  }

  onChooseItem(leaf: WorkspaceLeaf): void {
    this.app.workspace.revealLeaf(leaf);
  }

  private getLeafTerminalName(leaf: WorkspaceLeaf, view: TerminalView): string {
    const leafAny = leaf as any;
    const stateName = leafAny.getViewState?.()?.state?.name;
    if (typeof stateName === "string" && stateName.trim()) {
      return stateName.trim();
    }
    return view.getName();
  }
}
