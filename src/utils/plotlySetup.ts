/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Bundled Plotly build (replaces the old CDN <script> tag) so the packaged
// desktop app renders the 3D surfaces fully offline. Exposed on `window`
// because PlotlyView and the pinch/resize handlers read `window.Plotly`.
// @ts-ignore — plotly.js-dist-min ships no type definitions
import Plotly from 'plotly.js-dist-min';

(window as any).Plotly = Plotly;

export default Plotly;
