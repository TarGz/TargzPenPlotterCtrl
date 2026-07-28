// Reference Photo — drop a photo of the half-finished sheet under the toolpath
// preview, scale it onto the drawing, and read off where the pen stopped. Beats
// scrubbing thousands of lines blind when picking START / END.
//
// The mesh is a unit plane scaled to size, so resizing never rebuilds geometry.
// It is transparent, which puts it in three's transparent pass (drawn after the
// opaque work-area plane, and sorted back-to-front against the toolpath), and it
// sits below the lowest toolpath Z so the lines always read on top.

var plotPhotoMesh = null;
var plotPhotoAspect = 1;

function plotPhotoState() {
  return {
    x: parseFloat($('#cdPhotoX').val()) || 0,
    y: parseFloat($('#cdPhotoY').val()) || 0,
    w: parseFloat($('#cdPhotoW').val()) || 100,
    rot: parseFloat($('#cdPhotoRot').val()) || 0,
    opacity: (parseFloat($('#cdPhotoOpacity').val()) || 60) / 100
  };
}

function plotPhotoBaseZ() {
  var z = -0.25;
  if (typeof object !== 'undefined' && object && object.userData && object.userData.bbbox2) {
    z = Math.min(z, object.userData.bbbox2.min.z - 0.5);
  }
  return z;
}

// Push the control values onto the mesh.
function plotPhotoApply() {
  if (!plotPhotoMesh) return;
  var s = plotPhotoState();
  plotPhotoMesh.position.set(s.x, s.y, plotPhotoBaseZ());
  plotPhotoMesh.scale.set(s.w, s.w / plotPhotoAspect, 1);
  plotPhotoMesh.rotation.z = s.rot * Math.PI / 180;
  plotPhotoMesh.material.opacity = s.opacity;
  $('#cdPhotoH').text((s.w / plotPhotoAspect).toFixed(1) + ' mm');
}

// Size and centre the photo on the drawing's bounding box. The photo is of the
// sheet, so the drawn extents are the best first guess — then nudge from there.
function plotPhotoFitToDrawing() {
  if (!plotPhotoMesh) return;
  if (typeof object === 'undefined' || !object || !object.userData || !object.userData.bbbox2) {
    Metro.toast.create('Load a G-code file first — the fit uses its extents.', null, 3000, 'bg-orange');
    return;
  }
  var b = object.userData.bbbox2;
  var bw = b.max.x - b.min.x;
  var bh = b.max.y - b.min.y;

  // Match whichever axis keeps the whole drawing covered.
  var w = (bw / bh > plotPhotoAspect) ? bw : bh * plotPhotoAspect;

  $('#cdPhotoX').val(((b.min.x + b.max.x) / 2).toFixed(1));
  $('#cdPhotoY').val(((b.min.y + b.max.y) / 2).toFixed(1));
  $('#cdPhotoW').val(w.toFixed(1));
  $('#cdPhotoRot').val(0);
  plotPhotoApply();
}

function plotPhotoLoadFile(file) {
  if (!file) return;
  var reader = new FileReader();
  reader.onload = function (e) {
    new THREE.TextureLoader().load(e.target.result, function (texture) {
      plotPhotoAspect = texture.image.width / texture.image.height;
      plotPhotoRemove();

      plotPhotoMesh = new THREE.Mesh(
        new THREE.PlaneGeometry(1, 1),
        new THREE.MeshBasicMaterial({
          map: texture,
          transparent: true,
          opacity: 0.6,
          depthWrite: false
        })
      );
      plotPhotoMesh.name = 'plotPhoto';
      scene.add(plotPhotoMesh);

      $('#cd-photo-controls').show();
      plotPhotoFitToDrawing();
      plotPhotoApply();
    });
  };
  reader.readAsDataURL(file);
}

function plotPhotoRemove() {
  if (!plotPhotoMesh) return;
  scene.remove(plotPhotoMesh);
  if (plotPhotoMesh.material.map) plotPhotoMesh.material.map.dispose();
  plotPhotoMesh.material.dispose();
  plotPhotoMesh.geometry.dispose();
  plotPhotoMesh = null;
}

function plotPhotoClear() {
  plotPhotoRemove();
  $('#cd-photo-controls').hide();
  $('#cdPhotoFile').val('');
}

// A scene clear (new G-code load) detaches everything; put the photo back so an
// alignment survives re-parsing the file.
function plotPhotoReattach() {
  if (plotPhotoMesh && !scene.getObjectByName('plotPhoto')) {
    scene.add(plotPhotoMesh);
  }
}

$(document).ready(function () {
  $('#cdPhotoBtn').on('click', function () {
    $('#cd-photo-panel').toggle();
  });

  $('#cdPhotoClose').on('click', function () {
    $('#cd-photo-panel').hide();
  });

  $('#cdPhotoFile').on('change', function () {
    plotPhotoLoadFile(this.files && this.files[0]);
  });

  $('#cdPhotoX, #cdPhotoY, #cdPhotoW, #cdPhotoRot, #cdPhotoOpacity').on('input', plotPhotoApply);

  $('#cdPhotoFit').on('click', plotPhotoFitToDrawing);
  $('#cdPhotoRemoveBtn').on('click', plotPhotoClear);

  // Nudge the photo without retyping — alignment is a game of tenths.
  $('.cd-photo-nudge').on('click', function () {
    var axis = $(this).data('axis');
    var d = parseFloat($(this).data('delta'));
    var $f = (axis === 'x') ? $('#cdPhotoX') : $('#cdPhotoY');
    $f.val(((parseFloat($f.val()) || 0) + d).toFixed(1));
    plotPhotoApply();
  });
});
