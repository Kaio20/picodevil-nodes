import { page, userEvent } from "vitest/browser";
import { expect, it } from "vitest";
import { type ColorValue } from "./color-value";
import { colorField } from "./node-color-input";
import "./nodesdevil.css";

it("edits RGBA with the wheel, hex field and alpha slider, and shares recent colors", async () => {
  const commits: (ColorValue | undefined)[] = [];
  const first = colorField(undefined, "Text color", value => commits.push(value), true);
  const second = colorField({ hex: "#ff695b", alpha: 1 }, "Source color", value => commits.push(value));
  document.body.append(first, second);
  const recentKey = "nodesdevil-recent-colors";
  const previous = localStorage.getItem(recentKey);
  try {
    const textSwatch = page.getByRole("button", { name: "Text color", exact: true });
    await textSwatch.click();
    const picker = page.getByRole("dialog", { name: "Text color picker" });
    const hex = picker.getByRole("textbox", { name: "Hex" });
    await hex.fill("#cc4422");
    await userEvent.keyboard("{Enter}");
    expect(commits.at(-1)).toEqual({ hex: "#cc4422", alpha: 1 });

    const alpha = picker.getByRole("slider", { name: "Alpha" });
    (alpha.element() as HTMLElement).focus();
    await userEvent.keyboard("{Home}");
    expect(commits.at(-1)).toEqual({ hex: "#cc4422", alpha: 0 });
    await expect.element(hex).toHaveValue("#cc442200");

    (picker.getByRole("button", { name: "Color wheel" }).element() as HTMLElement).focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(commits.at(-1)?.hex).not.toBe("#cc4422");
    expect(commits.at(-1)?.alpha).toBe(0);

    await hex.fill("#12345680");
    await userEvent.keyboard("{Enter}");
    expect(commits.at(-1)).toEqual({ hex: "#123456", alpha: 128 / 255 });
    expect(JSON.parse(localStorage.getItem(recentKey)!)[0]).toEqual(commits.at(-1));
    await hex.fill("#nope");
    await userEvent.keyboard("{Enter}");
    await expect.element(hex).toHaveAttribute("aria-invalid", "true");
    expect(commits.at(-1)).toEqual({ hex: "#123456", alpha: 128 / 255 });

    await textSwatch.click();
    await expect.element(picker).not.toBeInTheDocument();
    await page.getByRole("button", { name: "Source color", exact: true }).click();
    await page.getByRole("button", { name: "Use #12345680" }).click();
    expect(commits.at(-1)).toEqual({ hex: "#123456", alpha: 128 / 255 });

    await textSwatch.click();
    await page.getByRole("button", { name: "Clear color override" }).click();
    expect(commits.at(-1)).toBeUndefined();
    await expect.element(textSwatch).toHaveAttribute("title", "Inherit color");
  } finally {
    first.remove();
    second.remove();
    if (previous === null) localStorage.removeItem(recentKey);
    else localStorage.setItem(recentKey, previous);
  }
});
