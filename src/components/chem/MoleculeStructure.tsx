'use client'

import { useEffect, useRef, useState } from 'react'

/**
 * Renders a 2D molecular structure from a SMILES string using RDKit (WASM).
 *
 * RDKit is loaded lazily via dynamic import (next/dynamic in the CAS page)
 * so this ~2MB WASM bundle only downloads when a user visits a chemical
 * detail page that actually has SMILES data. It never affects timeline,
 * search, or any other page.
 *
 * Rendering: RDKit parses SMILES → generates 2D coords → draws to an SVG
 * element. If the SMILES is invalid or RDKit fails to load, nothing renders
 * (the chemical info section still shows names normally).
 */

// The RDKit module loaded from the WASM CDN bundle.
// @rdkit/rdkit ships a minimal loader that fetches the WASM binary.
interface RDKitMol {
  is_valid(): boolean
  generate_aligned_coords(): void
  get_svg(width: number, height: number): string
  delete(): void
}

interface RDKitModule {
  get_mol(smiles: string): RDKitMol | null
}

interface RDKitGlobal extends Window {
  RDKit?: RDKitModule
  initRDKitModule?: () => Promise<RDKitModule>
}

let rdkitModule: RDKitModule | null = null
let rdkitPromise: Promise<RDKitModule | null> | null = null

async function loadRDKit(): Promise<RDKitModule | null> {
  if (rdkitModule) return rdkitModule
  if (rdkitPromise) return rdkitPromise

  rdkitPromise = (async () => {
    // RDKit JS is distributed as a UMD that attaches to window.
    // We load it from the official CDN to avoid bundling the WASM binary
    // through Next.js/Turbopack (which doesn't handle .wasm well).
    if (typeof window === 'undefined') return null
    const w = window as unknown as RDKitGlobal
    if (w.RDKit) {
      rdkitModule = w.RDKit
      return rdkitModule
    }
    await new Promise<void>((resolve, reject) => {
      const existing = document.getElementById('rdkit-loader')
      if (existing) {
        existing.addEventListener('load', () => resolve())
        existing.addEventListener('error', () => reject(new Error('RDKit load failed')))
        return
      }
      const script = document.createElement('script')
      script.id = 'rdkit-loader'
      script.src = 'https://unpkg.com/@rdkit/rdkit/Code/MinimalLib/dist/RDKit_minimal.js'
      script.async = true
      script.onload = () => resolve()
      script.onerror = () => reject(new Error('RDKit CDN failed'))
      document.head.appendChild(script)
    })
    // The script defines a global `initRDKitModule` that returns a promise.
    if (w.initRDKitModule) {
      rdkitModule = await w.initRDKitModule()
    } else if (w.RDKit) {
      rdkitModule = w.RDKit
    }
    return rdkitModule
  })()

  return rdkitPromise
}

export default function MoleculeStructure({
  smiles,
  width = 300,
  height = 250,
}: {
  smiles: string
  width?: number
  height?: number
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')

  useEffect(() => {
    let cancelled = false

    loadRDKit()
      .then((rdkit) => {
        if (cancelled || !rdkit || !containerRef.current) return

        const mol = rdkit.get_mol(smiles)
        if (!mol || !mol.is_valid()) {
          if (mol) mol.delete()
          setStatus('error')
          return
        }

        // Generate 2D coordinates if not present, then draw as SVG.
        mol.generate_aligned_coords()
        const svg = mol.get_svg(width, height)
        mol.delete()

        if (cancelled || !containerRef.current) return
        containerRef.current.innerHTML = svg
        setStatus('ready')
      })
      .catch(() => {
        if (!cancelled) setStatus('error')
      })

    return () => {
      cancelled = true
    }
  }, [smiles, width, height])

  if (status === 'loading') {
    return (
      <div
        className="flex items-center justify-center rounded-xl border border-line bg-canvas/50"
        style={{ width, height }}
      >
        <span className="h-5 w-5 animate-spin rounded-full border-2 border-line-strong border-t-brand" />
      </div>
    )
  }

  // On error, render nothing — the chemical info section still shows names.
  if (status === 'error') return null

  return (
    <div
      ref={containerRef}
      className="flex items-center justify-center rounded-xl border border-line bg-canvas/50 p-2"
      style={{ width, height }}
    />
  )
}
