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
    return view.getName();
  }

  renderSuggestion(leaf: { item: WorkspaceLeaf; match: any }, el: HTMLElement): void {
    const view = leaf.item.view as TerminalView;
    const wrapper = el.createDiv({ cls: "augment-ts-suggestion" });

    // Status dot
    const dot = wrapper.createDiv({ cls: "augment-ts-dot" });
    const status = view.getStatus();
    dot.addClass(status);

    // Name
    wrapper.createSpan({ cls: "augment-ts-name", text: view.getName() });
  }

  onChooseItem(leaf: WorkspaceLeaf): void {
    this.app.workspace.revealLeaf(leaf);
  }
}
