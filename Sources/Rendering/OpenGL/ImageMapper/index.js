/* eslint-disable no-undef */
/* eslint-disable eqeqeq */
import { vec3, mat4 } from 'gl-matrix';
import Constants from 'vtk.js/Sources/Rendering/Core/ImageMapper/Constants';
import * as macro from 'vtk.js/Sources/macros';
import vtkDataArray from 'vtk.js/Sources/Common/Core/DataArray';
import { VtkDataTypes } from 'vtk.js/Sources/Common/Core/DataArray/Constants';
import vtkHelper from 'vtk.js/Sources/Rendering/OpenGL/Helper';
import * as vtkMath from 'vtk.js/Sources/Common/Core/Math';
import vtkOpenGLTexture from 'vtk.js/Sources/Rendering/OpenGL/Texture';
import vtkShaderProgram from 'vtk.js/Sources/Rendering/OpenGL/ShaderProgram';
import vtkViewNode from 'vtk.js/Sources/Rendering/SceneGraph/ViewNode';
import { Representation } from 'vtk.js/Sources/Rendering/Core/Property/Constants';
import {
  Wrap,
  Filter,
} from 'vtk.js/Sources/Rendering/OpenGL/Texture/Constants';
import { InterpolationType } from 'vtk.js/Sources/Rendering/Core/ImageProperty/Constants';

import vtkPolyDataVS from 'vtk.js/Sources/Rendering/OpenGL/glsl/vtkPolyDataVS.glsl';
import vtkPolyDataFS from 'vtk.js/Sources/Rendering/OpenGL/glsl/vtkPolyDataFS.glsl';
import vtkReplacementShaderMapper from 'vtk.js/Sources/Rendering/OpenGL/ReplacementShaderMapper';

import { registerOverride } from 'vtk.js/Sources/Rendering/OpenGL/ViewNodeFactory';

const { vtkErrorMacro } = macro;

const { SlicingMode } = Constants;

// ----------------------------------------------------------------------------
// helper methods
// ----------------------------------------------------------------------------

function computeFnToString(property, pwfun, numberOfComponents) {
  if (pwfun) {
    const iComps = property.getIndependentComponents();
    return `${pwfun.getMTime()}-${iComps}-${numberOfComponents}`;
  }
  return '0';
}

// ----------------------------------------------------------------------------
// vtkOpenGLImageMapper methods
// ----------------------------------------------------------------------------

function vtkOpenGLImageMapper(publicAPI, model) {
  // Set our className
  model.classHierarchy.push('vtkOpenGLImageMapper');

  publicAPI.buildPass = (prepass) => {
    if (prepass) {
      model.currentRenderPass = null;
      model.openGLImageSlice = publicAPI.getFirstAncestorOfType(
        'vtkOpenGLImageSlice'
      );
      model._openGLRenderer =
        publicAPI.getFirstAncestorOfType('vtkOpenGLRenderer');
      model._openGLRenderWindow = model._openGLRenderer.getParent();
      model.context = model._openGLRenderWindow.getContext();
      model.tris.setOpenGLRenderWindow(model._openGLRenderWindow);
      model.openGLTexture.setOpenGLRenderWindow(model._openGLRenderWindow);
      // <--볼륨 데이터, 픽셀의 좌표 데이터를 저장할 텍스처 세팅-->
      model.volumeTexture.setOpenGLRenderWindow(model._openGLRenderWindow);
      model.MPRTexture.setOpenGLRenderWindow(model._openGLRenderWindow);
      // <--------------------->

      // CPR 관련 texture
      model.cprVelocityTexture.setOpenGLRenderWindow(model._openGLRenderWindow);
      model.cprRayTexture.setOpenGLRenderWindow(model._openGLRenderWindow);
      model.cprPositionTexture.setOpenGLRenderWindow(model._openGLRenderWindow);

      model.colorTexture.setOpenGLRenderWindow(model._openGLRenderWindow);
      model.pwfTexture.setOpenGLRenderWindow(model._openGLRenderWindow);
      const ren = model._openGLRenderer.getRenderable();
      model.openGLCamera = model._openGLRenderer.getViewNodeFor(
        ren.getActiveCamera()
      );
      // is slice set by the camera
      if (
        model.renderable.isA('vtkImageMapper') &&
        model.renderable.getSliceAtFocalPoint()
      ) {
        model.renderable.setSliceFromCamera(ren.getActiveCamera());
      }
    }
  };

  publicAPI.translucentPass = (prepass, renderPass) => {
    if (prepass) {
      model.currentRenderPass = renderPass;
      publicAPI.render();
    }
  };

  publicAPI.zBufferPass = (prepass) => {
    if (prepass) {
      model.haveSeenDepthRequest = true;
      model.renderDepth = true;
      publicAPI.render();
      model.renderDepth = false;
    }
  };

  publicAPI.opaqueZBufferPass = (prepass) => publicAPI.zBufferPass(prepass);

  publicAPI.opaquePass = (prepass) => {
    if (prepass) {
      publicAPI.render();
    }
  };

  publicAPI.getCoincidentParameters = (ren, actor) => {
    if (model.renderable.getResolveCoincidentTopology()) {
      return model.renderable.getCoincidentTopologyPolygonOffsetParameters();
    }
    return null;
  };

  // Renders myself
  publicAPI.render = () => {
    const actor = model.openGLImageSlice.getRenderable();
    const ren = model._openGLRenderer.getRenderable();
    publicAPI.renderPiece(ren, actor);
  };

  publicAPI.getShaderTemplate = (shaders, ren, actor) => {
    shaders.Vertex = vtkPolyDataVS;
    shaders.Fragment = vtkPolyDataFS;
    shaders.Geometry = '';
  };

  publicAPI.replaceShaderValues = (shaders, ren, actor) => {
    let VSSource = shaders.Vertex;
    let FSSource = shaders.Fragment;

    VSSource = vtkShaderProgram.substitute(VSSource, '//VTK::Camera::Dec', [
      'uniform mat4 MCPCMatrix;',
    ]).result;
    VSSource = vtkShaderProgram.substitute(
      VSSource,
      '//VTK::PositionVC::Impl',
      ['  gl_Position = MCPCMatrix * vertexMC;']
    ).result;

    VSSource = vtkShaderProgram.substitute(
      VSSource,
      '//VTK::TCoord::Impl',
      'tcoordVCVSOutput = tcoordMC;'
    ).result;

    VSSource = vtkShaderProgram.substitute(
      VSSource,
      '//VTK::TCoord::Dec',
      'attribute vec2 tcoordMC; varying vec2 tcoordVCVSOutput;'
    ).result;

    const tNumComp = model.openGLTexture.getComponents();
    const iComps = actor.getProperty().getIndependentComponents();

    let tcoordDec = [
      'varying vec2 tcoordVCVSOutput;',
      // color shift and scale
      'uniform float cshift0;',
      'uniform float cscale0;',
      // pwf shift and scale
      'uniform float pwfshift0;',
      'uniform float pwfscale0;',
      'uniform sampler2D texture1;',
      // <--MPR 관련 파라미터 추가-->
      'uniform sampler2D mprPos;',
      'uniform highp sampler3D texture2;',
      'uniform float mprSlicingMode;',
      'uniform float mprDirX;',
      'uniform float mprDirY;',
      'uniform float mprDirZ;',
      'uniform vec3 vsize;',
      'uniform vec3 vVCToIJK;',
      'uniform float mprThickness;',
      // <--------------------->
      'uniform sampler2D cvtexture;',
      'uniform sampler2D crtexture;',
      'uniform sampler2D cptexture;',
      'uniform float cprThickness;',
      'uniform float ciwidth;',
      'uniform float ciheight;',
      'uniform vec3 vVCToIJKSpacing;',
      'uniform sampler2D colorTexture1;',
      'uniform sampler2D pwfTexture1;',
      'uniform float opacity;',
    ];
    if (iComps) {
      for (let comp = 1; comp < tNumComp; comp++) {
        tcoordDec = tcoordDec.concat([
          // color shift and scale
          `uniform float cshift${comp};`,
          `uniform float cscale${comp};`,
          // weighting shift and scale
          `uniform float pwfshift${comp};`,
          `uniform float pwfscale${comp};`,
        ]);
      }
      // the heights defined below are the locations
      // for the up to four components of the tfuns
      // the tfuns have a height of 2XnumComps pixels so the
      // values are computed to hit the middle of the two rows
      // for that component
      switch (tNumComp) {
        case 1:
          tcoordDec = tcoordDec.concat([
            'uniform float mix0;',
            '#define height0 0.5',
          ]);
          break;
        case 2:
          tcoordDec = tcoordDec.concat([
            'uniform float mix0;',
            'uniform float mix1;',
            '#define height0 0.25',
            '#define height1 0.75',
          ]);
          break;
        case 3:
          tcoordDec = tcoordDec.concat([
            'uniform float mix0;',
            'uniform float mix1;',
            'uniform float mix2;',
            '#define height0 0.17',
            '#define height1 0.5',
            '#define height2 0.83',
          ]);
          break;
        case 4:
          tcoordDec = tcoordDec.concat([
            'uniform float mix0;',
            'uniform float mix1;',
            'uniform float mix2;',
            'uniform float mix3;',
            '#define height0 0.125',
            '#define height1 0.375',
            '#define height2 0.625',
            '#define height3 0.875',
          ]);
          break;
        default:
          vtkErrorMacro('Unsupported number of independent coordinates.');
      }
    }
    FSSource = vtkShaderProgram.substitute(
      FSSource,
      '//VTK::TCoord::Dec',
      tcoordDec
    ).result;

    if (iComps) {
      const rgba = ['r', 'g', 'b', 'a'];
      let tcoordImpl = ['vec4 tvalue = texture2D(texture1, tcoordVCVSOutput);'];
      for (let comp = 0; comp < tNumComp; comp++) {
        tcoordImpl = tcoordImpl.concat([
          `vec3 tcolor${comp} = mix${comp} * texture2D(colorTexture1, vec2(tvalue.${rgba[comp]} * cscale${comp} + cshift${comp}, height${comp})).rgb;`,
          `float compWeight${comp} = mix${comp} * texture2D(pwfTexture1, vec2(tvalue.${rgba[comp]} * pwfscale${comp} + pwfshift${comp}, height${comp})).r;`,
        ]);
      }
      switch (tNumComp) {
        case 1:
          tcoordImpl = tcoordImpl.concat([
            'gl_FragData[0] = vec4(tcolor0.rgb, opacity);',
          ]);
          break;
        case 2:
          tcoordImpl = tcoordImpl.concat([
            'float weightSum = compWeight0 + compWeight1;',
            'gl_FragData[0] = vec4(vec3((tcolor0.rgb * (compWeight0 / weightSum)) + (tcolor1.rgb * (compWeight1 / weightSum))), opacity);',
          ]);
          break;
        case 3:
          tcoordImpl = tcoordImpl.concat([
            'float weightSum = compWeight0 + compWeight1 + compWeight2;',
            'gl_FragData[0] = vec4(vec3((tcolor0.rgb * (compWeight0 / weightSum)) + (tcolor1.rgb * (compWeight1 / weightSum)) + (tcolor2.rgb * (compWeight2 / weightSum))), opacity);',
          ]);
          break;
        case 4:
          tcoordImpl = tcoordImpl.concat([
            'float weightSum = compWeight0 + compWeight1 + compWeight2 + compWeight3;',
            'gl_FragData[0] = vec4(vec3((tcolor0.rgb * (compWeight0 / weightSum)) + (tcolor1.rgb * (compWeight1 / weightSum)) + (tcolor2.rgb * (compWeight2 / weightSum)) + (tcolor3.rgb * (compWeight3 / weightSum))), opacity);',
          ]);
          break;
        default:
          vtkErrorMacro('Unsupported number of independent coordinates.');
      }
      FSSource = vtkShaderProgram.substitute(
        FSSource,
        '//VTK::TCoord::Impl',
        tcoordImpl
      ).result;
    } else {
      // dependent components
      switch (tNumComp) {
        case 1:
          // <--MPR 기능을 사용할 때 렌더링 셰이더 계산-->
          // 픽셀마다 3D 공간 내의 좌표 데이터(mpr_start)를 mprPos 값에서 계산하고
          // cross line의 각도, volueme data(texture2) 값으로 vothickness 계산을 수행한다.
          if (model.renderable.getMprMode()) {
            FSSource = vtkShaderProgram.substitute(
              FSSource,
              '//VTK::TCoord::Impl',
              [
                'float intensity = 0.0;',
                'vec3 mprDir = normalize(vec3(mprDirX, mprDirY, mprDirZ));',
                'vec3 mpr_start = texture2D(mprPos, tcoordVCVSOutput).rgb;',

                'vec3 mpr = vec3(0,0,0);',

                'float Maxt = floor(mprThickness/2.0);',
                'if(Maxt < 1.0){ Maxt = 0.5; }',
                'float count = 0.0;',

                'for(float t = -Maxt; t <= Maxt ; t=t+1.0) { ',
                ' mpr = (mpr_start + mprDir * t ) * vVCToIJK;',
                ' count += 1.0;',
                ' intensity += texture(texture2, mpr).r; }',
                'float avg = intensity / count;',

                'vec3 tcolor = texture2D(colorTexture1, vec2(avg * cscale0 + cshift0, 0.5)).rgb;',
                'float scalarOpacity = texture2D(pwfTexture1, vec2(avg * pwfscale0 + pwfshift0, 0.5)).r;',
                'gl_FragData[0] = vec4(tcolor, scalarOpacity * opacity);',
              ]
            ).result;
          }
          if (model.renderable.getCprMode()) {
            FSSource = vtkShaderProgram.substitute(
              FSSource,
              '//VTK::TCoord::Impl',
              [
                `
                vec2 st = tcoordVCVSOutput.xy;
                if (ciwidth > ciheight) {
                  st.y = (st.y - 0.5 + ciheight / ciwidth * 0.5) * ciwidth / ciheight;
                  if (st.y < 0.0 || st.y > 1.0) {
                    gl_FragData[0] = vec4(0.0, 0.0, 0.0, 1.0);
                    return;
                  }
                } else {
                  st.x = (st.x - 0.5 + ciwidth / ciheight * 0.5) * ciheight / ciwidth;
                  if (st.x < 0.0 || st.x > 1.0) {
                    gl_FragData[0] = vec4(0.0, 0.0, 0.0, 1.0);
                    return;
                  }
                }
                `,
                'vec4 vel = texture2D(cvtexture, vec2(st.x, 0.5));',
                'vec4 ray = texture2D(crtexture, vec2(st.x, 0.5));',
                'vec4 position = texture2D(cptexture, vec2(st.x, 0.5));',

                'vec4 img = position + ray * (st.y - 0.5) * ciheight;',

                // spline의 가속도와 cpr 진행 방향을 cross 하여 thickness의 진행방향을 얻습니다.
                'vec3 tRay = cross(ray.xyz, vel.xyz);',
                'tRay = normalize(tRay);',

                // volume 좌표를 shader에서 사용하는 좌표로 변경합니다.
                // 쉐이더는 volume좌표를 0~1범위로 변경해서 사용합니다.
                'img.xyz *= vVCToIJKSpacing;',
                'tRay.xyz *= vVCToIJKSpacing;',

                // thickness 진행
                'int thickness = max(2, int(cprThickness) + 1);',

                'vec3 sampleStep = tRay.xyz * cprThickness / float(thickness);',
                'vec3 start = img.xyz + -tRay.xyz * cprThickness * 0.5;',
                'float intensity = 0.0;',
                'int count = 0;',
                'for (int i = 0; i < thickness + 1; ++i) {',
                '  vec3 step = start + float(i) * sampleStep;',
                // 이미지 밖의 점은 까만색으로 처리
                `  if (step.x < 0.0 || step.x > 1.0) {
                     continue;
                   }
                   if (step.y < 0.0 || step.y > 1.0) {
                     continue;
                   }
                   if (step.z < 0.0 || step.z > 1.0) {
                     continue;
                   }`,
                '  count = count + 1;',
                '  intensity += texture(texture2, step).r;',
                '}',
                `if (count == 0) {
                  gl_FragData[0] = vec4(0.0, 0.0, 0.0, 1.0);
                  return;
                }`,
                'float avg = intensity / (float(thickness) + 1.0);',

                'vec3 tcolor = texture2D(colorTexture1, vec2(avg * cscale0 + cshift0, 0.5)).rgb;',
                'float scalarOpacity = texture2D(pwfTexture1, vec2(avg * pwfscale0 + pwfshift0, 0.5)).r;',
                'gl_FragData[0] = vec4(tcolor, scalarOpacity * opacity);',
              ]
            ).result;
          }
          // <--MPR 기능을 사용하지 않을 때 렌더링 셰이더 계산. 내용 기존과 동일.-->
          else {
            FSSource = vtkShaderProgram.substitute(
              FSSource,
              '//VTK::TCoord::Impl',
              [
                'float intensity = texture2D(texture1, tcoordVCVSOutput).r;',
                'vec3 tcolor = texture2D(colorTexture1, vec2(intensity * cscale0 + cshift0, 0.5)).rgb;',
                'float scalarOpacity = texture2D(pwfTexture1, vec2(intensity * pwfscale0 + pwfshift0, 0.5)).r;',
                'gl_FragData[0] = vec4(tcolor, scalarOpacity * opacity);',
              ]
            ).result;
          }
          // <--------------------->
          break;
        case 2:
          FSSource = vtkShaderProgram.substitute(
            FSSource,
            '//VTK::TCoord::Impl',
            [
              'vec4 tcolor = texture2D(texture1, tcoordVCVSOutput);',
              'float intensity = tcolor.r*cscale0 + cshift0;',
              'gl_FragData[0] = vec4(texture2D(colorTexture1, vec2(intensity, 0.5)).rgb, pwfscale0*tcolor.g + pwfshift0);',
            ]
          ).result;
          break;
        case 3:
          FSSource = vtkShaderProgram.substitute(
            FSSource,
            '//VTK::TCoord::Impl',
            [
              'vec4 tcolor = cscale0*texture2D(texture1, tcoordVCVSOutput.st) + cshift0;',
              'gl_FragData[0] = vec4(texture2D(colorTexture1, vec2(tcolor.r,0.5)).r,',
              '  texture2D(colorTexture1, vec2(tcolor.g,0.5)).r,',
              '  texture2D(colorTexture1, vec2(tcolor.b,0.5)).r, opacity);',
            ]
          ).result;
          break;
        default:
          FSSource = vtkShaderProgram.substitute(
            FSSource,
            '//VTK::TCoord::Impl',
            [
              'vec4 tcolor = cscale0*texture2D(texture1, tcoordVCVSOutput.st) + cshift0;',
              'gl_FragData[0] = vec4(texture2D(colorTexture1, vec2(tcolor.r,0.5)).r,',
              '  texture2D(colorTexture1, vec2(tcolor.g,0.5)).r,',
              '  texture2D(colorTexture1, vec2(tcolor.b,0.5)).r, tcolor.a);',
            ]
          ).result;
      }
    }

    if (model.haveSeenDepthRequest) {
      FSSource = vtkShaderProgram.substitute(
        FSSource,
        '//VTK::ZBuffer::Dec',
        'uniform int depthRequest;'
      ).result;
      FSSource = vtkShaderProgram.substitute(FSSource, '//VTK::ZBuffer::Impl', [
        'if (depthRequest == 1) {',
        'float iz = floor(gl_FragCoord.z*65535.0 + 0.1);',
        'float rf = floor(iz/256.0)/255.0;',
        'float gf = mod(iz,256.0)/255.0;',
        'gl_FragData[0] = vec4(rf, gf, 0.0, 1.0); }',
      ]).result;
    }

    shaders.Vertex = VSSource;
    shaders.Fragment = FSSource;

    publicAPI.replaceShaderClip(shaders, ren, actor);
    publicAPI.replaceShaderCoincidentOffset(shaders, ren, actor);
  };

  publicAPI.replaceShaderClip = (shaders, ren, actor) => {
    let VSSource = shaders.Vertex;
    let FSSource = shaders.Fragment;

    if (model.renderable.getNumberOfClippingPlanes()) {
      let numClipPlanes = model.renderable.getNumberOfClippingPlanes();
      if (numClipPlanes > 6) {
        macro.vtkErrorMacro('OpenGL has a limit of 6 clipping planes');
        numClipPlanes = 6;
      }
      VSSource = vtkShaderProgram.substitute(VSSource, '//VTK::Clip::Dec', [
        'uniform int numClipPlanes;',
        'uniform vec4 clipPlanes[6];',
        'varying float clipDistancesVSOutput[6];',
      ]).result;

      VSSource = vtkShaderProgram.substitute(VSSource, '//VTK::Clip::Impl', [
        'for (int planeNum = 0; planeNum < 6; planeNum++)',
        '    {',
        '    if (planeNum >= numClipPlanes)',
        '        {',
        '        break;',
        '        }',
        '    clipDistancesVSOutput[planeNum] = dot(clipPlanes[planeNum], vertexMC);',
        '    }',
      ]).result;
      FSSource = vtkShaderProgram.substitute(FSSource, '//VTK::Clip::Dec', [
        'uniform int numClipPlanes;',
        'varying float clipDistancesVSOutput[6];',
      ]).result;

      FSSource = vtkShaderProgram.substitute(FSSource, '//VTK::Clip::Impl', [
        'for (int planeNum = 0; planeNum < 6; planeNum++)',
        '    {',
        '    if (planeNum >= numClipPlanes)',
        '        {',
        '        break;',
        '        }',
        '    if (clipDistancesVSOutput[planeNum] < 0.0) discard;',
        '    }',
      ]).result;
    }
    shaders.Vertex = VSSource;
    shaders.Fragment = FSSource;
  };

  publicAPI.getNeedToRebuildShaders = (cellBO, ren, actor) => {
    // has something changed that would require us to recreate the shader?
    // candidates are
    // property modified (representation interpolation and lighting)
    // input modified
    // light complexity changed
    // render pass shader replacement changed

    const tNumComp = model.openGLTexture.getComponents();
    const iComp = actor.getProperty().getIndependentComponents();

    // has the render pass shader replacement changed? Two options
    let needRebuild = false;
    if (
      (!model.currentRenderPass && model.lastRenderPassShaderReplacement) ||
      (model.currentRenderPass &&
        model.currentRenderPass.getShaderReplacement() !==
          model.lastRenderPassShaderReplacement)
    ) {
      needRebuild = true;
    }

    if (
      needRebuild ||
      model.lastHaveSeenDepthRequest !== model.haveSeenDepthRequest ||
      cellBO.getProgram()?.getHandle() === 0 ||
      model.lastTextureComponents !== tNumComp ||
      model.lastIndependentComponents !== iComp
    ) {
      model.lastHaveSeenDepthRequest = model.haveSeenDepthRequest;
      model.lastTextureComponents = tNumComp;
      model.lastIndependentComponents = iComp;
      return true;
    }

    return false;
  };

  publicAPI.updateShaders = (cellBO, ren, actor) => {
    model.lastBoundBO = cellBO;

    // has something changed that would require us to recreate the shader?
    if (publicAPI.getNeedToRebuildShaders(cellBO, ren, actor)) {
      const shaders = { Vertex: null, Fragment: null, Geometry: null };

      publicAPI.buildShaders(shaders, ren, actor);

      // compile and bind the program if needed
      const newShader = model._openGLRenderWindow
        .getShaderCache()
        .readyShaderProgramArray(
          shaders.Vertex,
          shaders.Fragment,
          shaders.Geometry
        );

      // if the shader changed reinitialize the VAO
      if (newShader !== cellBO.getProgram()) {
        cellBO.setProgram(newShader);
        // reset the VAO as the shader has changed
        cellBO.getVAO().releaseGraphicsResources();
      }

      cellBO.getShaderSourceTime().modified();
    } else {
      model._openGLRenderWindow
        .getShaderCache()
        .readyShaderProgram(cellBO.getProgram());
    }

    cellBO.getVAO().bind();
    publicAPI.setMapperShaderParameters(cellBO, ren, actor);
    publicAPI.setCameraShaderParameters(cellBO, ren, actor);
    publicAPI.setPropertyShaderParameters(cellBO, ren, actor);
  };

  publicAPI.setMapperShaderParameters = (cellBO, ren, actor) => {
    // Now to update the VAO too, if necessary.

    if (
      cellBO.getCABO().getElementCount() &&
      (model.VBOBuildTime > cellBO.getAttributeUpdateTime().getMTime() ||
        cellBO.getShaderSourceTime().getMTime() >
          cellBO.getAttributeUpdateTime().getMTime())
    ) {
      if (cellBO.getProgram().isAttributeUsed('vertexMC')) {
        if (
          !cellBO
            .getVAO()
            .addAttributeArray(
              cellBO.getProgram(),
              cellBO.getCABO(),
              'vertexMC',
              cellBO.getCABO().getVertexOffset(),
              cellBO.getCABO().getStride(),
              model.context.FLOAT,
              3,
              model.context.FALSE
            )
        ) {
          vtkErrorMacro('Error setting vertexMC in shader VAO.');
        }
      }
      if (
        cellBO.getProgram().isAttributeUsed('tcoordMC') &&
        cellBO.getCABO().getTCoordOffset()
      ) {
        if (
          !cellBO
            .getVAO()
            .addAttributeArray(
              cellBO.getProgram(),
              cellBO.getCABO(),
              'tcoordMC',
              cellBO.getCABO().getTCoordOffset(),
              cellBO.getCABO().getStride(),
              model.context.FLOAT,
              cellBO.getCABO().getTCoordComponents(),
              model.context.FALSE
            )
        ) {
          vtkErrorMacro('Error setting tcoordMC in shader VAO.');
        }
      }
      cellBO.getAttributeUpdateTime().modified();
    }

    const texUnit = model.openGLTexture.getTextureUnit();
    cellBO.getProgram().setUniformi('texture1', texUnit);
    // <--셰이더에 볼륨 데이터를 저장한 텍스처 전송-->
    cellBO
      .getProgram()
      .setUniformi('texture2', model.volumeTexture.getTextureUnit());
    // <--------------------->
    // <--셰이더에 vctoijk 전송-->
    // volume 좌표를 shader에서 사용하는 좌표로 변경해야 합니다.
    // 쉐이더는 volume좌표를 0~1범위로 변경해서 사용합니다.
    // 해당 계산을 위해 필요한 값을 전송합니다.

    const extSpacing = model.currentInput.getExtent();
    const spc = model.currentInput.getSpacing();
    const vsizeSpacing = new Float64Array(3);
    vec3.set(
      vsizeSpacing,
      (extSpacing[1] - extSpacing[0]) * spc[0],
      (extSpacing[3] - extSpacing[2]) * spc[1],
      (extSpacing[5] - extSpacing[4]) * spc[2]
    );
    const vctoijkSpacing = new Float64Array(3);

    vec3.set(vctoijkSpacing, 1.0, 1.0, 1.0);
    vec3.divide(vctoijkSpacing, vctoijkSpacing, vsizeSpacing);
    cellBO
      .getProgram()
      .setUniform3f(
        'vVCToIJKSpacing',
        vctoijkSpacing[0],
        vctoijkSpacing[1],
        vctoijkSpacing[2]
      );

    const ext = [
      model.renderable.getXdimSize(),
      model.renderable.getYdimSize(),
      model.renderable.getZdimSize(),
    ];
    const vsize = new Float64Array(3);
    vec3.set(vsize, Number(ext[0]), Number(ext[1]), Number(ext[2]));
    const vctoijk = new Float64Array(3);
    vec3.set(vctoijk, 1.0, 1.0, 1.0);
    vec3.divide(vctoijk, vctoijk, vsize);
    cellBO.getProgram().setUniform3f('vsize', vsize[0], vsize[1], vsize[2]);
    cellBO
      .getProgram()
      .setUniform3f('vVCToIJK', vctoijk[0], vctoijk[1], vctoijk[2]);
    // <--------------------->
    // <--GPU MPR을 사용할 때 픽셀의 좌표 데이터와 cross line 데이터를 셰이더에 전송-->
    if (model.renderable.getMprMode()) {
      cellBO
        .getProgram()
        .setUniformi('mprPos', model.MPRTexture.getTextureUnit());
      const ijkMode = model.renderable.getMprSlicingMode();
      const mprDir = model.renderable
        .getInputConnection()
        .filter.getResliceAxes();
      cellBO
        .getProgram()
        .setUniformf('mprSlicingMode', model.renderable.getMprSlicingMode());
      if (ijkMode == SlicingMode.I) {
        cellBO.getProgram().setUniformf('mprDirX', mprDir[8]);
        cellBO.getProgram().setUniformf('mprDirY', mprDir[9]);
        cellBO.getProgram().setUniformf('mprDirZ', mprDir[10]);
      }
      if (ijkMode == SlicingMode.J) {
        cellBO.getProgram().setUniformf('mprDirX', mprDir[8]);
        cellBO.getProgram().setUniformf('mprDirY', mprDir[9]);
        cellBO.getProgram().setUniformf('mprDirZ', mprDir[10]);
      }
      if (ijkMode == SlicingMode.K || ijkMode == SlicingMode.NONE) {
        cellBO.getProgram().setUniformf('mprDirX', mprDir[8]);
        cellBO.getProgram().setUniformf('mprDirY', mprDir[9]);
        cellBO.getProgram().setUniformf('mprDirZ', mprDir[10]);
      }
    }
    // <--------------------->
    if (model.renderable.getCprMode()) {
      const cprPosition = model.renderable.getCprPosition();
      const cprThickness = model.renderable.getCprThickness();
      const cprImageWidth = model.renderable.getCprImageWidth();

      cellBO.getProgram().setUniformf('ciwidth', cprPosition.length);
      cellBO.getProgram().setUniformf('ciheight', cprImageWidth);
      cellBO.getProgram().setUniformf('cprThickness', cprThickness);
    }

    cellBO
      .getProgram()
      .setUniformi('cvtexture', model.cprVelocityTexture.getTextureUnit());
    cellBO
      .getProgram()
      .setUniformi('crtexture', model.cprRayTexture.getTextureUnit());
    cellBO
      .getProgram()
      .setUniformi('cptexture', model.cprPositionTexture.getTextureUnit());

    const numComp = model.openGLTexture.getComponents();
    const iComps = actor.getProperty().getIndependentComponents();
    if (iComps) {
      for (let i = 0; i < numComp; i++) {
        cellBO
          .getProgram()
          .setUniformf(`mix${i}`, actor.getProperty().getComponentWeight(i));
      }
    }

    const oglShiftScale = model.openGLTexture.getShiftAndScale();

    // three levels of shift scale combined into one
    // for performance in the fragment shader
    for (let i = 0; i < numComp; i++) {
      let cw = actor.getProperty().getColorWindow();
      let cl = actor.getProperty().getColorLevel();
      const target = iComps ? i : 0;
      const cfun = actor.getProperty().getRGBTransferFunction(target);
      if (cfun && actor.getProperty().getUseLookupTableScalarRange()) {
        const cRange = cfun.getRange();
        cw = cRange[1] - cRange[0];
        cl = 0.5 * (cRange[1] + cRange[0]);
      }

      const rescaleSlope = model.renderable.getRescaleSlope();
      const rescaleIntercept = model.renderable.getRescaleIntercept();

      const oglScale = oglShiftScale.scale / cw;
      const oglShift = (oglShiftScale.shift - cl) / cw + 0.5;

      const scale = rescaleSlope * oglScale;
      const shift = rescaleIntercept * oglScale + oglShift;
      cellBO.getProgram().setUniformf(`cshift${i}`, shift);
      cellBO.getProgram().setUniformf(`cscale${i}`, scale);
    }

    // pwf shift/scale
    for (let i = 0; i < numComp; i++) {
      let pwfScale = 1.0;
      let pwfShift = 0.0;
      const target = iComps ? i : 0;
      const pwfun = actor.getProperty().getPiecewiseFunction(target);
      if (pwfun) {
        const pwfRange = pwfun.getRange();
        const length = pwfRange[1] - pwfRange[0];
        const mid = 0.5 * (pwfRange[0] + pwfRange[1]);

        const rescaleSlope = model.renderable.getRescaleSlope();
        const rescaleIntercept = model.renderable.getRescaleIntercept();

        const oglScale = oglShiftScale.scale / length;
        const oglShift = (oglShiftScale.shift - mid) / length + 0.5;

        pwfScale = rescaleSlope * oglScale;
        pwfShift = rescaleIntercept * oglScale + oglShift;
      }
      cellBO.getProgram().setUniformf(`pwfshift${i}`, pwfShift);
      cellBO.getProgram().setUniformf(`pwfscale${i}`, pwfScale);
    }

    if (model.haveSeenDepthRequest) {
      cellBO
        .getProgram()
        .setUniformi('depthRequest', model.renderDepth ? 1 : 0);
    }

    // handle coincident
    if (cellBO.getProgram().isUniformUsed('coffset')) {
      const cp = publicAPI.getCoincidentParameters(ren, actor);
      cellBO.getProgram().setUniformf('coffset', cp.offset);
      // cfactor isn't always used when coffset is.
      if (cellBO.getProgram().isUniformUsed('cfactor')) {
        cellBO.getProgram().setUniformf('cfactor', cp.factor);
      }
    }

    const texColorUnit = model.colorTexture.getTextureUnit();
    cellBO.getProgram().setUniformi('colorTexture1', texColorUnit);

    const texOpacityUnit = model.pwfTexture.getTextureUnit();
    cellBO.getProgram().setUniformi('pwfTexture1', texOpacityUnit);

    if (model.renderable.getNumberOfClippingPlanes()) {
      // add all the clipping planes
      let numClipPlanes = model.renderable.getNumberOfClippingPlanes();
      if (numClipPlanes > 6) {
        macro.vtkErrorMacro('OpenGL has a limit of 6 clipping planes');
        numClipPlanes = 6;
      }

      const shiftScaleEnabled = cellBO.getCABO().getCoordShiftAndScaleEnabled();
      const inverseShiftScaleMatrix = shiftScaleEnabled
        ? cellBO.getCABO().getInverseShiftAndScaleMatrix()
        : null;
      const mat = inverseShiftScaleMatrix
        ? mat4.copy(model.imagematinv, actor.getMatrix())
        : actor.getMatrix();
      if (inverseShiftScaleMatrix) {
        mat4.transpose(mat, mat);
        mat4.multiply(mat, mat, inverseShiftScaleMatrix);
        mat4.transpose(mat, mat);
      }

      // transform crop plane normal with transpose(inverse(worldToIndex))
      mat4.transpose(model.imagemat, model.currentInput.getIndexToWorld());
      mat4.multiply(model.imagematinv, mat, model.imagemat);

      const planeEquations = [];
      for (let i = 0; i < numClipPlanes; i++) {
        const planeEquation = [];
        model.renderable.getClippingPlaneInDataCoords(
          model.imagematinv,
          i,
          planeEquation
        );

        for (let j = 0; j < 4; j++) {
          planeEquations.push(planeEquation[j]);
        }
      }
      cellBO.getProgram().setUniformi('numClipPlanes', numClipPlanes);
      cellBO.getProgram().setUniform4fv('clipPlanes', planeEquations);
    }
  };

  publicAPI.setCameraShaderParameters = (cellBO, ren, actor) => {
    const program = cellBO.getProgram();

    const actMats = model.openGLImageSlice.getKeyMatrices();
    const image = model.currentInput;
    const i2wmat4 = image.getIndexToWorld();
    mat4.multiply(model.imagemat, actMats.mcwc, i2wmat4);

    const keyMats = model.openGLCamera.getKeyMatrices(ren);
    mat4.multiply(model.imagemat, keyMats.wcpc, model.imagemat);

    if (cellBO.getCABO().getCoordShiftAndScaleEnabled()) {
      const inverseShiftScaleMat = cellBO
        .getCABO()
        .getInverseShiftAndScaleMatrix();
      mat4.multiply(model.imagemat, model.imagemat, inverseShiftScaleMat);
    }

    program.setUniformMatrix('MCPCMatrix', model.imagemat);
  };

  publicAPI.setPropertyShaderParameters = (cellBO, ren, actor) => {
    const program = cellBO.getProgram();

    const ppty = actor.getProperty();

    const opacity = ppty.getOpacity();
    program.setUniformf('opacity', opacity);
    // <--mpr 계산에 이용할 thinkness 파라미터 세팅-->
    program.setUniformf('mprThickness', model.renderable.getMprThickness());
    // <--------------------->
  };

  publicAPI.renderPieceStart = (ren, actor) => {
    // make sure the BOs are up to date
    publicAPI.updateBufferObjects(ren, actor);

    // Bind the OpenGL, this is shared between the different primitive/cell types.
    model.lastBoundBO = null;
  };

  publicAPI.renderPieceDraw = (ren, actor) => {
    const gl = model.context;

    // activate the texture
    model.openGLTexture.activate();
    // <--볼륨 데이터, 픽셀의 좌표 데이터를 저장할 텍스처 세팅-->
    model.volumeTexture.activate();
    model.MPRTexture.activate();
    // <--------------------->

    // CPR 관련 texture
    model.cprVelocityTexture.activate();
    model.cprRayTexture.activate();
    model.cprPositionTexture.activate();

    model.colorTexture.activate();
    model.pwfTexture.activate();

    // draw polygons
    if (model.tris.getCABO().getElementCount()) {
      // First we do the triangles, update the shader, set uniforms, etc.
      publicAPI.updateShaders(model.tris, ren, actor);
      gl.drawArrays(gl.TRIANGLES, 0, model.tris.getCABO().getElementCount());
      model.tris.getVAO().release();
    }

    model.openGLTexture.deactivate();
    // <--볼륨 데이터, 픽셀의 좌표 데이터를 저장할 텍스처 세팅-->
    model.volumeTexture.deactivate();
    model.MPRTexture.deactivate();
    // <--------------------->

    model.cprVelocityTexture.deactivate();
    model.cprRayTexture.deactivate();
    model.cprPositionTexture.deactivate();

    model.colorTexture.deactivate();
    model.pwfTexture.deactivate();
  };

  publicAPI.renderPieceFinish = (ren, actor) => {};

  publicAPI.renderPiece = (ren, actor) => {
    // Make sure that we have been properly initialized.
    // if (ren.getRenderWindow().checkAbortStatus()) {
    //   return;
    // }

    publicAPI.invokeEvent({ type: 'StartEvent' });
    model.renderable.update();
    model.currentInput = model.renderable.getCurrentImage();
    publicAPI.invokeEvent({ type: 'EndEvent' });

    if (!model.currentInput) {
      vtkErrorMacro('No input!');
      return;
    }

    publicAPI.renderPieceStart(ren, actor);
    publicAPI.renderPieceDraw(ren, actor);
    publicAPI.renderPieceFinish(ren, actor);
  };

  publicAPI.computeBounds = (ren, actor) => {
    if (!publicAPI.getInput()) {
      vtkMath.uninitializeBounds(model.bounds);
      return;
    }
    model.bounds = publicAPI.getInput().getBounds();
  };

  publicAPI.updateBufferObjects = (ren, actor) => {
    // Rebuild buffers if needed
    if (publicAPI.getNeedToRebuildBufferObjects(ren, actor)) {
      publicAPI.buildBufferObjects(ren, actor);
    }
  };

  publicAPI.getNeedToRebuildBufferObjects = (ren, actor) => {
    // first do a coarse check
    if (
      model.VBOBuildTime.getMTime() < publicAPI.getMTime() ||
      model.VBOBuildTime.getMTime() < actor.getMTime() ||
      model.VBOBuildTime.getMTime() < model.renderable.getMTime() ||
      model.VBOBuildTime.getMTime() < actor.getProperty().getMTime() ||
      model.VBOBuildTime.getMTime() < model.currentInput.getMTime()
    ) {
      return true;
    }
    return false;
  };

  publicAPI.buildBufferObjects = (ren, actor) => {
    const image = model.currentInput;

    if (!image) {
      return;
    }

    const imgScalars =
      image.getPointData() && image.getPointData().getScalars();

    if (!imgScalars) {
      return;
    }

    const dataType = imgScalars.getDataType();
    const numComp = imgScalars.getNumberOfComponents();

    const actorProperty = actor.getProperty();

    const iType = actorProperty.getInterpolationType();
    model.MPRTexture.setMinificationFilter(Filter.LINEAR);
    model.MPRTexture.setMagnificationFilter(Filter.LINEAR);

    model.MPRTexture.setWrapS(Wrap.CLAMP_TO_EDGE);
    model.MPRTexture.setWrapT(Wrap.CLAMP_TO_EDGE);

    model.volumeTexture.setMinificationFilter(Filter.LINEAR);
    model.volumeTexture.setMagnificationFilter(Filter.LINEAR);

    const cprPosition = model.renderable.getCprPosition();
    const cprRay = model.renderable.getCprRay();
    const cprVelocity = model.renderable.getCprVelocity();
    const width = cprPosition?.length ?? 1;

    let cvTable;
    let crTable;
    let cpTable;
    if (model.renderable.getCprMode()) {
      cvTable = new Float32Array(cprVelocity.flat());
      crTable = new Float32Array(cprRay.flat());
      cpTable = new Float32Array(cprPosition.flat());
    } else {
      cvTable = new Float32Array(width * 3);
      crTable = new Float32Array(width * 3);
      cpTable = new Float32Array(width * 3);
    }

    model.cprVelocityTexture.releaseGraphicsResources(
      model._openGLRenderWindow
    );
    model.cprVelocityTexture.setMinificationFilter(Filter.LINEAR);
    model.cprVelocityTexture.setMagnificationFilter(Filter.LINEAR);

    model.cprRayTexture.releaseGraphicsResources(model._openGLRenderWindow);
    model.cprRayTexture.setMinificationFilter(Filter.LINEAR);
    model.cprRayTexture.setMagnificationFilter(Filter.LINEAR);

    model.cprPositionTexture.releaseGraphicsResources(
      model._openGLRenderWindow
    );
    model.cprPositionTexture.setMinificationFilter(Filter.LINEAR);
    model.cprPositionTexture.setMagnificationFilter(Filter.LINEAR);

    model.cprVelocityTexture.create2DFromRaw(
      width,
      1,
      3,
      VtkDataTypes.FLOAT,
      cvTable
    );
    model.cprRayTexture.create2DFromRaw(
      width,
      1,
      3,
      VtkDataTypes.FLOAT,
      crTable
    );
    model.cprPositionTexture.create2DFromRaw(
      width,
      1,
      3,
      VtkDataTypes.FLOAT,
      cpTable
    );

    // <--------------------->
    const iComps = actorProperty.getIndependentComponents();
    const numIComps = iComps ? numComp : 1;
    const textureHeight = iComps ? 2 * numIComps : 1;

    const colorTransferFunc = actorProperty.getRGBTransferFunction();
    const cfunToString = computeFnToString(
      actorProperty,
      colorTransferFunc,
      numIComps
    );
    const cTex =
      model._openGLRenderWindow.getGraphicsResourceForObject(colorTransferFunc);

    const reBuildC =
      !cTex?.vtkObj ||
      cTex?.hash !== cfunToString ||
      model.colorTextureString !== cfunToString;
    if (reBuildC) {
      const cWidth = 1024;
      const cSize = cWidth * textureHeight * 3;
      const cTable = new Uint8Array(cSize);
      if (!model.colorTexture) {
        model.colorTexture = vtkOpenGLTexture.newInstance({
          resizable: true,
        });
        model.colorTexture.setOpenGLRenderWindow(model._openGLRenderWindow);
      }
      // set interpolation on the texture based on property setting
      if (iType === InterpolationType.NEAREST) {
        model.colorTexture.setMinificationFilter(Filter.NEAREST);
        model.colorTexture.setMagnificationFilter(Filter.NEAREST);
      } else {
        model.colorTexture.setMinificationFilter(Filter.LINEAR);
        model.colorTexture.setMagnificationFilter(Filter.LINEAR);
      }

      if (colorTransferFunc) {
        const tmpTable = new Float32Array(cWidth * 3);

        for (let c = 0; c < numIComps; c++) {
          const cfun = actorProperty.getRGBTransferFunction(c);
          const cRange = cfun.getRange();
          cfun.getTable(cRange[0], cRange[1], cWidth, tmpTable, 1);
          if (iComps) {
            for (let i = 0; i < cWidth * 3; i++) {
              cTable[c * cWidth * 6 + i] = 255.0 * tmpTable[i];
              cTable[c * cWidth * 6 + i + cWidth * 3] = 255.0 * tmpTable[i];
            }
          } else {
            for (let i = 0; i < cWidth * 3; i++) {
              cTable[c * cWidth * 6 + i] = 255.0 * tmpTable[i];
            }
          }
        }
        model.colorTexture.releaseGraphicsResources(model._openGLRenderWindow);
        model.colorTexture.resetFormatAndType();
        model.colorTexture.create2DFromRaw(
          cWidth,
          textureHeight,
          3,
          VtkDataTypes.UNSIGNED_CHAR,
          cTable
        );
      } else {
        for (let i = 0; i < cWidth * 3; ++i) {
          cTable[i] = (255.0 * i) / ((cWidth - 1) * 3);
          cTable[i + 1] = (255.0 * i) / ((cWidth - 1) * 3);
          cTable[i + 2] = (255.0 * i) / ((cWidth - 1) * 3);
        }
        model.colorTexture.create2DFromRaw(
          cWidth,
          1,
          3,
          VtkDataTypes.UNSIGNED_CHAR,
          cTable
        );
      }

      model.colorTextureString = cfunToString;
      if (colorTransferFunc) {
        model._openGLRenderWindow.setGraphicsResourceForObject(
          colorTransferFunc,
          model.colorTexture,
          model.colorTextureString
        );
      }
    } else {
      model.colorTexture = cTex.vtkObj;
      model.colorTextureString = cTex.hash;
    }

    // Build piecewise function buffer.  This buffer is used either
    // for component weighting or opacity, depending on whether we're
    // rendering components independently or not.
    const pwFunc = actorProperty.getPiecewiseFunction();
    const pwfunToString = computeFnToString(actorProperty, pwFunc, numIComps);
    const pwfTex =
      model._openGLRenderWindow.getGraphicsResourceForObject(pwFunc);
    // rebuild opacity tfun?
    const reBuildPwf =
      !pwfTex?.vtkObj ||
      pwfTex?.hash !== pwfunToString ||
      model.pwfTextureString !== pwfunToString;
    if (reBuildPwf) {
      const pwfWidth = 1024;
      const pwfSize = pwfWidth * textureHeight;
      const pwfTable = new Uint8Array(pwfSize);
      if (!model.pwfTexture) {
        model.pwfTexture = vtkOpenGLTexture.newInstance({
          resizable: true,
        });
        model.pwfTexture.setOpenGLRenderWindow(model._openGLRenderWindow);
      }
      // set interpolation on the texture based on property setting
      if (iType === InterpolationType.NEAREST) {
        model.pwfTexture.setMinificationFilter(Filter.NEAREST);
        model.pwfTexture.setMagnificationFilter(Filter.NEAREST);
      } else {
        model.pwfTexture.setMinificationFilter(Filter.LINEAR);
        model.pwfTexture.setMagnificationFilter(Filter.LINEAR);
      }

      if (pwFunc) {
        const pwfFloatTable = new Float32Array(pwfSize);
        const tmpTable = new Float32Array(pwfWidth);

        for (let c = 0; c < numIComps; ++c) {
          const pwfun = actorProperty.getPiecewiseFunction(c);
          if (pwfun === null) {
            // Piecewise constant max if no function supplied for this component
            pwfFloatTable.fill(1.0);
          } else {
            const pwfRange = pwfun.getRange();
            pwfun.getTable(pwfRange[0], pwfRange[1], pwfWidth, tmpTable, 1);
            // adjust for sample distance etc
            if (iComps) {
              for (let i = 0; i < pwfWidth; i++) {
                pwfFloatTable[c * pwfWidth * 2 + i] = tmpTable[i];
                pwfFloatTable[c * pwfWidth * 2 + i + pwfWidth] = tmpTable[i];
              }
            } else {
              for (let i = 0; i < pwfWidth; i++) {
                pwfFloatTable[c * pwfWidth * 2 + i] = tmpTable[i];
              }
            }
          }
        }
        model.pwfTexture.releaseGraphicsResources(model._openGLRenderWindow);
        model.pwfTexture.resetFormatAndType();
        model.pwfTexture.create2DFromRaw(
          pwfWidth,
          textureHeight,
          1,
          VtkDataTypes.FLOAT,
          pwfFloatTable
        );
      } else {
        // default is opaque
        pwfTable.fill(255.0);
        model.pwfTexture.create2DFromRaw(
          pwfWidth,
          1,
          1,
          VtkDataTypes.UNSIGNED_CHAR,
          pwfTable
        );
      }

      model.pwfTextureString = pwfunToString;
      if (pwFunc) {
        model._openGLRenderWindow.setGraphicsResourceForObject(
          pwFunc,
          model.pwfTexture,
          model.pwfTextureString
        );
      }
    } else {
      model.pwfTexture = pwfTex.vtkObj;
      model.pwfTextureString = pwfTex.hash;
    }

    // Find what IJK axis and what direction to slice along
    const { ijkMode } = model.renderable.getClosestIJKAxis();

    // Find the IJK slice
    let slice = model.renderable.getSlice();
    if (ijkMode !== model.renderable.getSlicingMode()) {
      // If not IJK slicing, get the IJK slice from the XYZ position/slice
      slice = model.renderable.getSliceAtPosition(slice);
    }

    // Use sub-Slice number/offset if mapper being used is vtkImageArrayMapper,
    // since this mapper uses a collection of vtkImageData (and not just a single vtkImageData).
    const nSlice = model.renderable.isA('vtkImageArrayMapper')
      ? model.renderable.getSubSlice() // get subSlice of the current (possibly multi-frame) image
      : Math.round(slice);

    // Find sliceOffset
    const ext = image.getExtent();
    let sliceOffset;
    if (ijkMode === SlicingMode.I) {
      sliceOffset = nSlice - ext[0];
    }
    if (ijkMode === SlicingMode.J) {
      sliceOffset = nSlice - ext[2];
    }
    if (ijkMode === SlicingMode.K || ijkMode === SlicingMode.NONE) {
      sliceOffset = nSlice - ext[4];
    }
    // <--텍스처에 픽셀의 좌표 데이터를 저장-->
    // <--GPU MPR 기능을 사용하지 않을 시 최소한의 크기만 가지도록 처리-->
    if (model.renderable.getMprMode()) {
      const MprCoordTexture = model.renderable
        .getInputConnection()
        .filter.getMprCoordTexture();
      const dims = image.getDimensions();

      model.MPRTexture.create2DFromRaw(
        dims[0],
        dims[1],
        3,
        VtkDataTypes.Uint16Array,
        MprCoordTexture
      );
    } else {
      model.MPRTexture.create2DFromRaw(
        1,
        1,
        3,
        VtkDataTypes.UNSIGNED_SHORT,
        new Uint16Array(3).fill(1)
      );
    }
    model.MPRTexture.activate();
    model.MPRTexture.sendParameters();
    model.MPRTexture.deactivate();
    // <--------------------->
    // <--텍스처에 볼륨 데이터를 저장-->
    if (model.volumeTextureString != 1) {
      const openglDataType = model.currentInput
        .getPointData()
        .getScalars()
        .getDataType();
      const volScalars = model.renderable
        .getOriginalData()
        ?.getPointData()
        ?.getScalars();

      const dim = [
        model.renderable.getXdimSize(),
        model.renderable.getYdimSize(),
        model.renderable.getZdimSize(),
      ];

      if (
        (model.renderable.getMprMode() || model.renderable.getCprMode()) &&
        volScalars
      ) {
        // <--텍스처에 저장할 볼륨 데이터-->
        // <--------------------->
        // rebuild the scalarTexture if the data has changed

        model.volumeTexture.releaseGraphicsResources(model._openGLRenderWindow);
        model.volumeTexture.resetFormatAndType();
        model.volumeTexture.create3DFilterableFromRaw(
          Number(dim[0]),
          Number(dim[1]),
          Number(dim[2]),
          numComp,
          volScalars.getDataType(),
          volScalars.getData(),
          true
          // model.renderable.getPreferSizeOverAccuracy()
          // Whether to use halfFloat representation of float, when it is inaccurate
        );
      } else {
        model.volumeTexture.releaseGraphicsResources(model._openGLRenderWindow);
        model.volumeTexture.resetFormatAndType();
        model.volumeTexture.create3DFilterableFromRaw(
          1,
          1,
          1,
          numComp,
          openglDataType,
          new Uint16Array(1).fill(1),
          true
        );
      }
      model.volumeTexture.activate();
      model.volumeTexture.sendParameters();
      model.volumeTexture.deactivate();

      model.volumeTextureString = 1;
    }
    // <--------------------->

    // rebuild the VBO if the data has changed
    const toString = `${slice}A${image.getMTime()}A${imgScalars.getMTime()}B${publicAPI.getMTime()}C${model.renderable.getSlicingMode()}D${actor
      .getProperty()
      .getInterpolationType()}`;
    if (model.VBOBuildString !== toString) {
      // Build the VBOs
      const dims = image.getDimensions();
      if (!model.openGLTexture) {
        model.openGLTexture = vtkOpenGLTexture.newInstance({
          resizable: true,
        });
        model.openGLTexture.setOpenGLRenderWindow(model._openGLRenderWindow);
      }
      if (iType === InterpolationType.NEAREST) {
        if (
          new Set([1, 3, 4]).has(numComp) &&
          dataType === VtkDataTypes.UNSIGNED_CHAR &&
          !iComps
        ) {
          model.openGLTexture.setGenerateMipmap(true);
          model.openGLTexture.setMinificationFilter(Filter.NEAREST);
        } else {
          model.openGLTexture.setMinificationFilter(Filter.NEAREST);
        }
        model.openGLTexture.setMagnificationFilter(Filter.NEAREST);
      } else {
        if (
          numComp === 4 &&
          dataType === VtkDataTypes.UNSIGNED_CHAR &&
          !iComps
        ) {
          model.openGLTexture.setGenerateMipmap(true);
          model.openGLTexture.setMinificationFilter(
            Filter.LINEAR_MIPMAP_LINEAR
          );
        } else {
          model.openGLTexture.setMinificationFilter(Filter.LINEAR);
        }
        model.openGLTexture.setMagnificationFilter(Filter.LINEAR);
      }
      model.openGLTexture.setWrapS(Wrap.CLAMP_TO_EDGE);
      model.openGLTexture.setWrapT(Wrap.CLAMP_TO_EDGE);
      const sliceSize = dims[0] * dims[1] * numComp;

      const ptsArray = new Float32Array(12);
      const tcoordArray = new Float32Array(8);
      for (let i = 0; i < 4; i++) {
        tcoordArray[i * 2] = i % 2 ? 1.0 : 0.0;
        tcoordArray[i * 2 + 1] = i > 1 ? 1.0 : 0.0;
      }

      // Determine depth position of the slicing plane in the scene.
      // Slicing modes X, Y, and Z use a continuous axis position, whereas
      // slicing modes I, J, and K should use discrete positions.
      const sliceDepth = [SlicingMode.X, SlicingMode.Y, SlicingMode.Z].includes(
        model.renderable.getSlicingMode()
      )
        ? slice
        : nSlice;

      const spatialExt = image.getSpatialExtent();
      const basicScalars = imgScalars.getData();
      let scalars = null;
      // Get right scalars according to slicing mode
      if (ijkMode === SlicingMode.I) {
        scalars = new basicScalars.constructor(dims[2] * dims[1] * numComp);
        let id = 0;
        for (let k = 0; k < dims[2]; k++) {
          for (let j = 0; j < dims[1]; j++) {
            let bsIdx =
              (sliceOffset + j * dims[0] + k * dims[0] * dims[1]) * numComp;
            id = (k * dims[1] + j) * numComp;
            const end = bsIdx + numComp;
            while (bsIdx < end) {
              scalars[id++] = basicScalars[bsIdx++];
            }
          }
        }
        dims[0] = dims[1];
        dims[1] = dims[2];
        ptsArray[0] = sliceDepth;
        ptsArray[1] = spatialExt[2];
        ptsArray[2] = spatialExt[4];
        ptsArray[3] = sliceDepth;
        ptsArray[4] = spatialExt[3];
        ptsArray[5] = spatialExt[4];
        ptsArray[6] = sliceDepth;
        ptsArray[7] = spatialExt[2];
        ptsArray[8] = spatialExt[5];
        ptsArray[9] = sliceDepth;
        ptsArray[10] = spatialExt[3];
        ptsArray[11] = spatialExt[5];
      } else if (ijkMode === SlicingMode.J) {
        scalars = new basicScalars.constructor(dims[2] * dims[0] * numComp);
        let id = 0;
        for (let k = 0; k < dims[2]; k++) {
          for (let i = 0; i < dims[0]; i++) {
            let bsIdx =
              (i + sliceOffset * dims[0] + k * dims[0] * dims[1]) * numComp;
            id = (k * dims[0] + i) * numComp;
            const end = bsIdx + numComp;
            while (bsIdx < end) {
              scalars[id++] = basicScalars[bsIdx++];
            }
          }
        }
        dims[1] = dims[2];
        ptsArray[0] = spatialExt[0];
        ptsArray[1] = sliceDepth;
        ptsArray[2] = spatialExt[4];
        ptsArray[3] = spatialExt[1];
        ptsArray[4] = sliceDepth;
        ptsArray[5] = spatialExt[4];
        ptsArray[6] = spatialExt[0];
        ptsArray[7] = sliceDepth;
        ptsArray[8] = spatialExt[5];
        ptsArray[9] = spatialExt[1];
        ptsArray[10] = sliceDepth;
        ptsArray[11] = spatialExt[5];
      } else if (ijkMode === SlicingMode.K || ijkMode === SlicingMode.NONE) {
        scalars = basicScalars.subarray(
          sliceOffset * sliceSize,
          (sliceOffset + 1) * sliceSize
        );
        ptsArray[0] = spatialExt[0];
        ptsArray[1] = spatialExt[2];
        ptsArray[2] = sliceDepth;
        ptsArray[3] = spatialExt[1];
        ptsArray[4] = spatialExt[2];
        ptsArray[5] = sliceDepth;
        ptsArray[6] = spatialExt[0];
        ptsArray[7] = spatialExt[3];
        ptsArray[8] = sliceDepth;
        ptsArray[9] = spatialExt[1];
        ptsArray[10] = spatialExt[3];
        ptsArray[11] = sliceDepth;
      } else {
        vtkErrorMacro('Reformat slicing not yet supported.');
      }

      const tex =
        model._openGLRenderWindow.getGraphicsResourceForObject(scalars);
      if (!tex?.vtkObj) {
        if (model._scalars !== scalars) {
          model._openGLRenderWindow.releaseGraphicsResourcesForObject(
            model._scalars
          );
          model._scalars = scalars;
        }
        model.openGLTexture.resetFormatAndType();
        model.openGLTexture.create2DFilterableFromRaw(
          dims[0],
          dims[1],
          numComp,
          imgScalars.getDataType(),
          scalars,
          model.renderable.getPreferSizeOverAccuracy?.()
        );
        model._openGLRenderWindow.setGraphicsResourceForObject(
          scalars,
          model.openGLTexture,
          model.VBOBuildString
        );
      } else {
        model.openGLTexture = tex.vtkObj;
        model.VBOBuildString = tex.hash;
      }
      model.openGLTexture.activate();
      model.openGLTexture.sendParameters();
      model.openGLTexture.deactivate();

      const points = vtkDataArray.newInstance({
        numberOfComponents: 3,
        values: ptsArray,
      });
      points.setName('points');
      const tcoords = vtkDataArray.newInstance({
        numberOfComponents: 2,
        values: tcoordArray,
      });
      tcoords.setName('tcoords');

      const cellArray = new Uint16Array(8);
      cellArray[0] = 3;
      cellArray[1] = 0;
      cellArray[2] = 1;
      cellArray[3] = 3;
      cellArray[4] = 3;
      cellArray[5] = 0;
      cellArray[6] = 3;
      cellArray[7] = 2;
      const cells = vtkDataArray.newInstance({
        numberOfComponents: 1,
        values: cellArray,
      });

      model.tris.getCABO().createVBO(cells, 'polys', Representation.SURFACE, {
        points,
        tcoords,
        cellOffset: 0,
      });
      model.VBOBuildTime.modified();
      model.VBOBuildString = toString;
    }
  };
}

// ----------------------------------------------------------------------------
// Object factory
// ----------------------------------------------------------------------------

const DEFAULT_VALUES = {
  VBOBuildTime: 0,
  VBOBuildString: null,
  openGLTexture: null,
  // <--볼륨 데이터, 픽셀의 좌표 데이터를 저장할 텍스처 추가-->
  MPRTexture: null,
  volumeTexture: null,
  volumeTextureString: null,
  cprVelocityTexture: null,
  cprRayTexture: null,
  cprPositionTexture: null,
  // <--------------------->
  tris: null,
  imagemat: null,
  imagematinv: null,
  colorTexture: null,
  pwfTexture: null,
  lastHaveSeenDepthRequest: false,
  haveSeenDepthRequest: false,
  lastTextureComponents: 0,
  _scalars: null,
};

// ----------------------------------------------------------------------------

export function extend(publicAPI, model, initialValues = {}) {
  Object.assign(model, DEFAULT_VALUES, initialValues);

  // Inheritance
  vtkViewNode.extend(publicAPI, model, initialValues);
  vtkReplacementShaderMapper.implementReplaceShaderCoincidentOffset(
    publicAPI,
    model,
    initialValues
  );
  vtkReplacementShaderMapper.implementBuildShadersWithReplacements(
    publicAPI,
    model,
    initialValues
  );

  model.tris = vtkHelper.newInstance();
  model.openGLTexture = vtkOpenGLTexture.newInstance();
  // <--볼륨 데이터, 픽셀의 좌표 데이터를 저장할 텍스처 세팅-->
  model.MPRTexture = vtkOpenGLTexture.newInstance({
    resizable: true,
  });
  model.volumeTexture = vtkOpenGLTexture.newInstance();
  // <--------------------->
  model.cprVelocityTexture = vtkOpenGLTexture.newInstance();
  model.cprRayTexture = vtkOpenGLTexture.newInstance();
  model.cprPositionTexture = vtkOpenGLTexture.newInstance();
  model.colorTexture = vtkOpenGLTexture.newInstance();
  model.pwfTexture = vtkOpenGLTexture.newInstance();

  model.imagemat = mat4.identity(new Float64Array(16));
  model.imagematinv = mat4.identity(new Float64Array(16));

  // Build VTK API
  macro.setGet(publicAPI, model, []);

  model.VBOBuildTime = {};
  macro.obj(model.VBOBuildTime);

  // Object methods
  vtkOpenGLImageMapper(publicAPI, model);
}

// ----------------------------------------------------------------------------

export const newInstance = macro.newInstance(extend, 'vtkOpenGLImageMapper');

// ----------------------------------------------------------------------------

export default { newInstance, extend };

// Register ourself to OpenGL backend if imported
registerOverride('vtkAbstractImageMapper', newInstance);
