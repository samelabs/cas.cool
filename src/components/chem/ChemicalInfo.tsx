'use client'

import dynamic from 'next/dynamic'

// Lazy-load the molecule renderer so the RDKit WASM bundle (~2MB) only
// downloads when a CAS page actually has SMILES data.
const MoleculeStructure = dynamic(
  () => import('./MoleculeStructure'),
  { ssr: false },
)

/**
 * Chemical info section for the CAS detail page.
 *
 * Client component because the molecule renderer (RDKit WASM) requires
 * browser APIs. The name list + banned flag are plain data passed as props.
 */
export function ChemicalInfo({
  names,
  smiles,
  banned,
}: {
  names: string[]
  smiles: string | null
  banned: boolean
}) {
  return (
    <>
      {/* Banned flag */}
      {banned && (
        <span className="mt-1 inline-flex items-center gap-1 rounded-full bg-danger/10 px-2.5 py-0.5 text-xs font-semibold text-danger">
          Restricted
        </span>
      )}

      {/* Multi-name display: each name on its own line.
          Supports multi-language and trade names (semicolon-separated). */}
      {names.length > 0 && (
        <div className="mt-1.5 space-y-0.5">
          {names.map((n, i) => (
            <p key={i} className="text-base leading-relaxed text-ink">
              {n}
            </p>
          ))}
        </div>
      )}

      {/* Molecular structure — RDKit WASM, lazy-loaded, zero impact on other pages */}
      {smiles && (
        <div className="mt-4 flex justify-center">
          <MoleculeStructure smiles={smiles} width={300} height={250} />
        </div>
      )}
    </>
  )
}
