import { createContext, useContext } from "react";

export type ToastType = "success" | "info" | "error";
export type ShowToast = (msg: string, type?: ToastType) => void;

// App provides a stable function (it only sets state), so consumers can use it in effect deps
export const ToastContext = createContext<ShowToast>(() => {});

export const useToast = () => useContext(ToastContext);
