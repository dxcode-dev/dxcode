export const shouldOpenMobileSidebarByDefault = (
  mobile: boolean,
  pathname: string,
) => mobile && pathname === "/";
