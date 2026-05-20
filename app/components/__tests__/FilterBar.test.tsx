import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { FilterBar, type FilterQuery } from "@/app/components/FilterBar";

const emptyQ: FilterQuery = {
  phone: "", client: "", invoice: "", from: "", to: "", type: "Alle",
};

function renderBar(overrides: Partial<{
  q: FilterQuery;
  quickOn: string;
  applied: { k: string; v: string }[];
  setQ: (q: FilterQuery) => void;
  setQuickOn: (k: string) => void;
  removeApplied: (k: string) => void;
  onSearch: () => void;
  onClear: () => void;
}> = {}) {
  const setQ = overrides.setQ ?? vi.fn();
  const setQuickOn = overrides.setQuickOn ?? vi.fn();
  const removeApplied = overrides.removeApplied ?? vi.fn();
  const onSearch = overrides.onSearch ?? vi.fn();
  const onClear = overrides.onClear ?? vi.fn();

  render(
    <FilterBar
      q={overrides.q ?? emptyQ}
      setQ={setQ}
      quickOn={overrides.quickOn ?? ""}
      setQuickOn={setQuickOn}
      applied={overrides.applied ?? []}
      removeApplied={removeApplied}
      onSearch={onSearch}
      onClear={onClear}
    />
  );
  return { setQ, setQuickOn, removeApplied, onSearch, onClear };
}

describe("FilterBar", () => {
  it("renders all six filter fields and the type segmented control", () => {
    renderBar();
    expect(screen.getByLabelText("Filter by phone")).toBeInTheDocument();
    expect(screen.getByLabelText("Filter by client")).toBeInTheDocument();
    expect(screen.getByLabelText("Filter by invoice number")).toBeInTheDocument();
    expect(screen.getByLabelText("From date")).toBeInTheDocument();
    expect(screen.getByLabelText("To date")).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Invoice type" })).toBeInTheDocument();
  });

  it("calls setQ with updated value when typing in a field", () => {
    const setQ = vi.fn();
    renderBar({ setQ });
    fireEvent.change(screen.getByLabelText("Filter by client"), { target: { value: "Nema" } });
    expect(setQ).toHaveBeenCalledWith({ ...emptyQ, client: "Nema" });
  });

  it("selecting Inkoop fires setQ with type=Inkoop", () => {
    const setQ = vi.fn();
    renderBar({ setQ });
    fireEvent.click(screen.getByRole("button", { name: "Inkoop" }));
    expect(setQ).toHaveBeenCalledWith({ ...emptyQ, type: "Inkoop" });
  });

  it("Search button fires onSearch; Clear button fires onClear", () => {
    const onSearch = vi.fn();
    const onClear = vi.fn();
    renderBar({ onSearch, onClear });
    fireEvent.click(screen.getByRole("button", { name: /apply search/i }));
    fireEvent.click(screen.getByRole("button", { name: /clear all filters/i }));
    expect(onSearch).toHaveBeenCalledTimes(1);
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it("clicking a quick chip toggles it via setQuickOn", () => {
    const setQuickOn = vi.fn();
    renderBar({ setQuickOn, quickOn: "" });
    fireEvent.click(screen.getByRole("button", { name: "Today" }));
    expect(setQuickOn).toHaveBeenCalledWith("today");
  });

  it("clicking the same quick chip while it is on clears it", () => {
    const setQuickOn = vi.fn();
    renderBar({ setQuickOn, quickOn: "today" });
    fireEvent.click(screen.getByRole("button", { name: "Today" }));
    expect(setQuickOn).toHaveBeenCalledWith("");
  });

  it("renders applied chips and fires removeApplied on the × button", () => {
    const removeApplied = vi.fn();
    renderBar({ applied: [{ k: "client", v: "Nema" }], removeApplied });
    expect(screen.getByText("client:")).toBeInTheDocument();
    expect(screen.getByText("Nema")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /remove client filter/i }));
    expect(removeApplied).toHaveBeenCalledWith("client");
  });
});
