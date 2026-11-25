export function phosphorIcon(name: string, className?: string) {
  const icon = document.createElement("span");
  icon.classList.add("ph", `ph-${name}`);
  if (className) icon.classList.add(className);
  icon.setAttribute("aria-hidden", "true");
  return icon;
}
