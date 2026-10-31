import { createContext, useContext } from "react";

export interface Navigation {
  /** Call right before changing "the page" inside a view (e.g. History → an anime's timeline), so Back returns */
  remember: () => void;
}

// App provides a stable object
export const NavigationContext = createContext<Navigation>({ remember: () => {} });

export const useNavigation = () => useContext(NavigationContext);
