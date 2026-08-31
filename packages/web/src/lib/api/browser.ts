"use client"

import { useAuth } from "@clerk/nextjs"
import { useMemo } from "react"
import { authConfigured } from "@/env"
import { createApi, type Api } from "./operations"

/**
 * The API, as the browser sees it.
 *
 * Memoised on Clerk's `getToken`, which is stable across renders, so the client
 * is built once per session rather than per render — and so passing `api` into
 * a `useEffect` dependency list does not restart the effect on every keystroke.
 * That matters more than it looks: the run stream lives in an effect, and a
 * client identity that changed each render would tear down and re-establish an
 * SSE connection continuously.
 */
export function useApi(): Api {
  const { getToken } = useAuth()

  return useMemo(
    () =>
      createApi(async () => {
        if (!authConfigured()) return null
        return getToken()
      }),
    [getToken],
  )
}
