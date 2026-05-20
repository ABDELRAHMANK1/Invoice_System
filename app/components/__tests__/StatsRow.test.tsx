import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatsRow } from "@/app/components/StatsRow";

describe("StatsRow", () => {
  it("renders all four stat labels", () => {
    render(<StatsRow total={12} totalAmount={1234.5} pending={3} avgConfidence={92} />);
    expect(screen.getByText("Invoices this month")).toBeInTheDocument();
    expect(screen.getByText("Value this month")).toBeInTheDocument();
    expect(screen.getByText("Pending review")).toBeInTheDocument();
    expect(screen.getByText("Avg. confidence")).toBeInTheDocument();
  });

  it("renders the integer count values exactly", () => {
    render(<StatsRow total={12} totalAmount={1234.5} pending={3} avgConfidence={92} />);
    expect(screen.getByText("12")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("92%")).toBeInTheDocument();
  });

  it("formats amount as Dutch EUR currency", () => {
    const { container } = render(
      <StatsRow total={1} totalAmount={1234.5} pending={0} avgConfidence={0} />
    );
    // nl-NL formatting produces "€ 1.234,50" (with non-breaking space).
    // We check for the presence of "1.234,50" which is locale-stable.
    expect(container.textContent).toMatch(/1\.234,50/);
  });

  it("renders the colored accent bar on each card", () => {
    const { container } = render(
      <StatsRow total={1} totalAmount={1} pending={0} avgConfidence={0} />
    );
    expect(container.querySelectorAll(".stat-bar")).toHaveLength(4);
  });

  it("renders supporting subtitle text under each value", () => {
    render(<StatsRow total={5} totalAmount={100} pending={2} avgConfidence={88} />);
    expect(screen.getByText("of 5 total")).toBeInTheDocument();
    expect(screen.getByText("net total")).toBeInTheDocument();
    expect(screen.getByText("needs your attention")).toBeInTheDocument();
    expect(screen.getByText("across 5 invoices")).toBeInTheDocument();
  });
});
