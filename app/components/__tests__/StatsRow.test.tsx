import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatsRow } from "@/app/components/StatsRow";

const cards = [
  { label: "Total invoices", value: "12", sub: "across your workspace", accent: "#0ea5e9" },
  { label: "Total value", value: "€ 1.234,50", sub: "sum of invoice totals", accent: "#10b981" },
];

describe("StatsRow", () => {
  it("renders a card per entry with its label, value and subtitle", () => {
    render(<StatsRow cards={cards} />);
    expect(screen.getByText("Total invoices")).toBeInTheDocument();
    expect(screen.getByText("12")).toBeInTheDocument();
    expect(screen.getByText("across your workspace")).toBeInTheDocument();
    expect(screen.getByText("Total value")).toBeInTheDocument();
    expect(screen.getByText("sum of invoice totals")).toBeInTheDocument();
  });

  it("renders one accent bar per card", () => {
    const { container } = render(<StatsRow cards={cards} />);
    expect(container.querySelectorAll(".stat-bar")).toHaveLength(cards.length);
  });

  it("renders no confidence or pending-review widgets", () => {
    render(<StatsRow cards={cards} />);
    expect(screen.queryByText(/confidence/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/pending review/i)).not.toBeInTheDocument();
  });
});
