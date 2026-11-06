using System.Web.Http;

namespace Legacy.Api.Controllers
{
    [RoutePrefix("api/orders")]
    public class OrdersController : ApiController
    {
        [HttpGet]
        [Route("")]
        public IHttpActionResult GetAll() { return Ok(); }

        [Route("{id:int}")]
        public IHttpActionResult GetOrder(int id) { return Ok(); }

        [HttpPost]
        [Route("")]
        public IHttpActionResult Create([FromBody] OrderDto dto) { return Ok(); }

        [HttpDelete]
        [Route("~/api/v1/orders/{id:int}")]
        public IHttpActionResult Remove(int id) { return Ok(); }
    }

    public class OrderDto { public string Sku { get; set; } }
}
