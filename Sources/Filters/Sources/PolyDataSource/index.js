/* eslint-disable */
import macro from 'vtk.js/Sources/macro';
import vtkPolyData from 'vtk.js/Sources/Common/DataModel/PolyData';

function vtkPolyDataSource(publicAPI, model) {
    model.classHierarchy.push('vtkPolyDataSource');

    publicAPI.requestData = (inData, outData) => {
        const dataset = vtkPolyData.newInstance();  
        const point = new Float32Array(model.points.length * 2);
        point.set(model.points, 0);
        point.set(model.points, model.points.length);

        for(let i = 2;i < model.points.length; i= i + 3){
            point[i                ] = point[i] + model.margin;
            point[i + model.points.length] = point[i] - model.margin;
        }

        const pointSize = model.points.length / 3;
        const edgeSize = (pointSize + 1) * 2 + pointSize * 5;
        const edge = new Uint32Array(edgeSize);
        edge[0] = pointSize;
        edge[pointSize + 1] = pointSize;
        for(let i = 0; i < pointSize; ++i){
            edge[i + 1] = i;
            edge[i + 1 + pointSize + 1] = pointSize + i;
        }

        let idx = 0;
        for(let i = (pointSize + 2) * 2; i <  edgeSize; i = i + 5){
            edge[i + 0] = 4;
            edge[i + 1] = idx + 0;
            edge[i + 2] = idx + 1 < pointSize ? idx + 1 : 0;
            edge[i + 3] = idx + 1 + pointSize < pointSize * 2 ? idx + 1 + pointSize : pointSize ;
            edge[i + 4] = idx + 0 + pointSize;
            ++idx;
        }
    
        dataset.getPoints().setData(point, 3);
        dataset.getPolys().setData(edge, 1);

        outData[0] = dataset;
    };
}
const DEFAULT_VALUES ={
    points: null,
    margin: 1,
}

export function extend(publicAPI, model, initialValues = {}) {
    Object.assign(model, DEFAULT_VALUES, initialValues);
  
    // Build VTK API
    macro.obj(publicAPI, model);
    macro.setGet(publicAPI, model, ['points']);
    macro.algo(publicAPI, model, 0, 1);
    vtkPolyDataSource(publicAPI, model);
}

export const newInstance = macro.newInstance(extend, 'vtkPolyDataSource');

// ----------------------------------------------------------------------------

export default { newInstance, extend };