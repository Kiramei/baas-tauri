export const DEFAULT_PROFILE_NAME = "New Profile";

/** The backend's built-in placeholder is a UI default, independent of the app language. */
export function profileDisplayName(name: string): string {
  return name === "新的配置" ? DEFAULT_PROFILE_NAME : name;
}

export function unusedDefaultProfileName(isTaken: (name: string) => boolean): string {
  let candidate = DEFAULT_PROFILE_NAME;
  for (let number = 2; isTaken(candidate); number += 1)
    candidate = `${DEFAULT_PROFILE_NAME} ${number}`;
  return candidate;
}
