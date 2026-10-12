// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ValidatedNumberInput } from "./ValidatedNumberInput";
afterEach(cleanup);

describe("validated numeric drafts", () => {
  it.each(["", " ", "NaN", "Infinity", "abc", "1.5", "9007199254740992", "0", "4"])("rejects invalid integer draft %j without coercion", (text) => {
    const onValue = vi.fn(() => true);
    render(<ValidatedNumberInput label="Plane" value={2} integer minimum={1} maximum={3} onValue={onValue} />);
    const input = screen.getByLabelText("Plane");
    fireEvent.change(input, { target: { value: text } });
    fireEvent.blur(input);
    expect(input).toHaveValue(text);
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription("Enter a whole number from 1 to 3.");
    expect(onValue).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input).toHaveValue("2");
    expect(input).toHaveAttribute("aria-invalid", "false");
  });
  it("commits full decimal precision and allows negative finite values when no lower bound applies", () => {
    const onValue = vi.fn(() => true);
    const view = render(<ValidatedNumberInput label="Offset" value={0} onValue={onValue} />);
    const input = screen.getByLabelText("Offset");
    fireEvent.change(input, { target: { value: "-1.23456789012345" } });
    expect(onValue).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.blur(input);
    expect(onValue).toHaveBeenCalledExactlyOnceWith(-1.23456789012345);
    fireEvent.change(input, { target: { value: "unfinished" } });
    view.rerender(<ValidatedNumberInput label="Offset" value={5} onValue={onValue} />);
    expect(input).toHaveValue("5");
  });
  it("preserves stateful decimal and exponent typing while rejecting unfinished submissions", () => {
    const accepted = vi.fn(); const validity = vi.fn();
    function Form() {
      const [value, setValue] = useState(10);
      return <ValidatedNumberInput label="Scientific value" value={value} commitOnChange onValidity={validity}
        onValue={(number) => { accepted(number); setValue(number); return true; }} />;
    }
    render(<Form />);
    const input = screen.getByLabelText("Scientific value");
    for (const text of ["1", "1.", "1.2", "-", "-1", "-1.2", "-1.2e", "-1.2e-", "-1.2e-3"]) {
      fireEvent.change(input, { target: { value: text } });
      expect(input).toHaveValue(text);
    }
    expect(accepted.mock.calls.map(([value]) => value)).toEqual([1, 1.2, -1, -1.2, -0.0012]);
    expect(validity.mock.calls.map(([value]) => value)).toContain(false);
    fireEvent.change(input, { target: { value: "" } });
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(accepted).toHaveBeenLastCalledWith(-0.0012);
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input).toHaveValue("-0.0012");
    expect(validity).toHaveBeenLastCalledWith(true);
  });

});
