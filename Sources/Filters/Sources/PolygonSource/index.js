/* eslint-disable */
import macro from 'vtk.js/Sources/macro';
import vtkPolyData from 'vtk.js/Sources/Common/DataModel/PolyData';

function vtkPolygonSource(publicAPI, model) {
    model.classHierarchy.push('vtkPolygonSource');

    publicAPI.requestData = (inData, outData) => {
        const dataset = vtkPolyData.newInstance();
    
        const edgeSize = model.points.length / 3;
        const edges = new Uint32Array(edgeSize + 1);
        edges[0] = edgeSize;
        for(let i = 0; i < edgeSize; ++i){
            edges[i + 1] = i;
        }
    
        dataset.getPoints().setData(model.points, 3);
        dataset.getPolys().setData(edges, 1);

        outData[0] = dataset;
    };
}
const DEFAULT_VALUES ={
    points: null,
}

export function extend(publicAPI, model, initialValues = {}) {
    Object.assign(model, DEFAULT_VALUES, initialValues);
  
    // Build VTK API
    macro.obj(publicAPI, model);
    macro.setGet(publicAPI, model, ['points']);
    macro.algo(publicAPI, model, 0, 1);
    vtkPolygonSource(publicAPI, model);
}

export const newInstance = macro.newInstance(extend, 'vtkPolygonSource');

// ----------------------------------------------------------------------------

export default { newInstance, extend };