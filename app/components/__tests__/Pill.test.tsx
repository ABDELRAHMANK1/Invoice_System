import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Pill, TypePill, statusTone, statusLabel } from "@/app/components/Pill";

describe("Pill component", () => {
  it("renders children with default 'info' tone", () => {
    const { container } = render(<Pill>Hello</Pill>);
    expect(screen.getByText("Hello")).toBeInTheDocument();
    expect(container.querySelector(".pill")).toHaveClass("s-info");
  });

  it("applies the supplied tone class", () => {
    const { container } = render(<Pill tone="danger">Failed</Pill>);
    expect(container.querySelector(".pill")).toHaveClass("s-danger");
  });

  it("renders a status dot before the label", () => {
    const { container } = render(<Pill tone="good">Done</Pill>);
    expect(container.querySelector(".pill-dot")).toBeInTheDocument();
  });
});

describe("TypePill", () => {
  it("renders Inkoop with the inkoop class", () => {
    const { container } = render(<TypePill type="Inkoop" />);
    expect(container.querySelector(".pill")).toHaveClass("t-inkoop");
    expect(screen.getByText("Inkoop")).toBeInTheDocument();
  });

  it("renders Verkoop with the verkoop class", () => {
    const { container } = render(<TypePill type="Verkoop" />);
    expect(container.querySelector(".pill")).toHaveClass("t-verkoop");
    expect(screen.getByText("Verkoop")).toBeInTheDocument();
  });
});

describe("statusTone()", () => {
  it("maps extracted/done → good", () => {
    expect(statusTone("extracted")).toBe("good");
    expect(statusTone("done")).toBe("good");
  });

  it("maps pending/processing → info", () => {
    expect(statusTone("pending")).toBe("info");
    expect(statusTone("processing")).toBe("info");
  });

  it("maps review → warn", () => {
    expect(statusTone("review")).toBe("warn");
  });

  it("maps unknown/error → danger", () => {
    expect(statusTone("error")).toBe("danger");
    expect(statusTone("???")).toBe("danger");
  });
});

describe("statusLabel()", () => {
  it("returns user-facing label for each known status", () => {
    expect(statusLabel("extracted")).toBe("extracted");
    expect(statusLabel("done")).toBe("extracted");
    expect(statusLabel("pending")).toBe("pending");
    expect(statusLabel("processing")).toBe("processing");
    expect(statusLabel("review")).toBe("needs review");
  });

  it("returns 'failed' for unknown statuses", () => {
    expect(statusLabel("error")).toBe("failed");
    expect(statusLabel("garbage")).toBe("failed");
  });
});
