/**
 * Access/refresh token persistence, under the same "fire-smoke:*" localStorage
 * convention App.jsx already uses for the theme (see MODE_KEY there).
 *
 * The access token also rides an httpOnly cookie the backend sets on login,
 * for the three <img src> endpoints (camera snapshot, event frame, found-item
 * crop) that cannot attach an Authorization header -- that cookie is not
 * readable or managed here, the browser handles it automatically.
 */
const ACCESS_KEY = "fire-smoke:access-token";
const REFRESH_KEY = "fire-smoke:refresh-token";

export function getAccessToken() {
  return localStorage.getItem(ACCESS_KEY);
}

export function getRefreshToken() {
  return localStorage.getItem(REFRESH_KEY);
}

export function setTokens({ accessToken, refreshToken }) {
  if (accessToken) localStorage.setItem(ACCESS_KEY, accessToken);
  if (refreshToken) localStorage.setItem(REFRESH_KEY, refreshToken);
}

export function clearTokens() {
  localStorage.removeItem(ACCESS_KEY);
  localStorage.removeItem(REFRESH_KEY);
}

export default { getAccessToken, getRefreshToken, setTokens, clearTokens };
