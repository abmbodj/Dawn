/** Pure string-replace logic for the edit tool, separated for testability. */
export function applyEdit(
  content: string,
  oldString: string,
  newString: string,
  replaceAll = false,
): string {
  if (oldString === newString) throw new Error("oldString and newString are identical")
  if (oldString === "") throw new Error("oldString must not be empty")
  const count = content.split(oldString).length - 1
  if (count === 0) throw new Error("oldString not found in file")
  if (count > 1 && !replaceAll) {
    throw new Error(
      `oldString matches ${count} times — make it unique by adding surrounding lines, or set replaceAll`,
    )
  }
  return replaceAll ? content.split(oldString).join(newString) : content.replace(oldString, newString)
}
